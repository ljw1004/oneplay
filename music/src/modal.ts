/**
 * Shared modal/dropdown primitives for select/settings UIs.
 *
 * Scope:
 * - Low-level DOM helpers for modal inputs/positioning/lifecycle behavior.
 * - Reusable shell primitives shared by multiple UI modules.
 *
 * Non-scope:
 * - Feature-specific modal content/business rules (owned by callers such as
 *   select.ts/select-dialogs.ts/settings.ts).
 */

/** Focuses a connected text input synchronously so iOS opens the keyboard. */
export function focusTextInput(input: HTMLInputElement, selectAll = false): void {
    if (!input.isConnected) return;
    try {
        input.focus({ preventScroll: true });
    } catch {
        input.focus();
    }
    if (selectAll) input.select();
}

/**
 * Configures a title/name text input for keyboard dictionary suggestions
 * while suppressing profile/contact autofill suggestions on iOS.
 */
export function configureNameTextInput(input: HTMLInputElement): void {
    input.inputMode = 'text';
    input.autocomplete = 'off';
    input.spellcheck = true;
    input.setAttribute('autocorrect', 'on');
    input.setAttribute('autocapitalize', 'words');
}

/**
 * Shows a modal dialog. Backdrop click calls close().
 * close() removes the DOM and optionally calls onClose callback.
 *
 * INVARIANT: buildBody runs only after the modal is mounted in the DOM.
 */
export function showModal(
    title: string,
    buildBody: (modal: HTMLElement, close: () => void) => void,
    onClose?: () => void,
    topBiased = false,
): void {
    const existing = document.querySelector('.modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop' + (topBiased ? ' text-entry-modal' : '');

    const modal = document.createElement('div');
    modal.className = 'modal';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    modal.appendChild(h3);

    const close = (): void => {
        backdrop.remove();
        onClose?.();
    };

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    buildBody(modal, close);

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
}

/**
 * Builds a Cancel + confirm/danger action row for modals.
 * Supports async confirm with abort-on-cancel.
 */
export function addModalActions(
    modal: HTMLElement,
    close: () => void,
    confirmLabel: string,
    onConfirm: (signal?: AbortSignal) => Promise<void> | void,
    danger = false,
    onError?: (error: unknown) => void,
): HTMLButtonElement {
    const errorLine = document.createElement('div');
    errorLine.className = 'modal-error';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'modal-cancel';
    cancelBtn.textContent = 'Cancel';

    let inFlight = false;
    let confirmAbort: AbortController | undefined;

    cancelBtn.addEventListener('click', () => {
        if (inFlight) confirmAbort?.abort();
        close();
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger ? 'modal-danger' : 'modal-confirm';

    const confirmLabelNode = document.createElement('span');
    confirmLabelNode.textContent = confirmLabel;
    const confirmSpinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    confirmSpinner.setAttribute('viewBox', '0 0 16 16');
    confirmSpinner.setAttribute('aria-hidden', 'true');
    confirmSpinner.classList.add('sync-spinner', 'modal-button-spinner');
    confirmSpinner.innerHTML = '<circle cx="8" cy="8" r="5"/>';
    confirmSpinner.style.display = 'none';

    const setConfirmLoading = (loading: boolean): void => {
        confirmLabelNode.hidden = loading;
        confirmSpinner.style.display = loading ? 'inline' : 'none';
    };

    confirmBtn.append(confirmLabelNode, confirmSpinner);
    confirmBtn.addEventListener('click', () => {
        if (inFlight) return;
        const run = async (): Promise<void> => {
            inFlight = true;
            confirmAbort = typeof AbortController === 'function' ? new AbortController() : undefined;
            confirmBtn.disabled = true;
            setConfirmLoading(true);
            errorLine.textContent = '';
            try {
                await Promise.resolve(onConfirm(confirmAbort?.signal));
                close();
            } catch (e) {
                const aborted = confirmAbort?.signal.aborted === true;
                if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
                const message = e instanceof Error ? e.message : '';
                errorLine.textContent = message || 'Action failed';
                onError?.(e);
                confirmBtn.disabled = false;
                setConfirmLoading(false);
            } finally {
                inFlight = false;
                confirmAbort = undefined;
            }
        };
        run().catch(() => {});
    });

    actions.append(cancelBtn, confirmBtn);
    modal.append(errorLine, actions);
    return confirmBtn;
}

/** Returns a stable string identity for an element (lazy-assigned). */
function anchorId(el: HTMLElement): string {
    if (el.dataset.anchorId) return el.dataset.anchorId;
    const assigned = String(Math.floor(Math.random() * 1_000_000_000));
    el.dataset.anchorId = assigned;
    return assigned;
}

/** Shows a dropdown near anchorEl. Dismissed on outside click or re-tap. */
export function showDropdown(
    anchorEl: HTMLElement,
    items: Array<{ label: string; danger?: boolean; chevron?: boolean; onClick: () => void }>,
    className = 'action-dropdown',
): void {
    const existing = document.querySelector(`.${className}`) as HTMLElement | null;
    const wasAnchor = existing?.dataset.anchorId;
    existing?.remove();

    if (wasAnchor && wasAnchor === anchorId(anchorEl)) return;

    const dropdown = document.createElement('div');
    dropdown.className = className;
    dropdown.dataset.anchorId = anchorId(anchorEl);

    for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        if (item.danger) btn.classList.add('danger');
        if (item.chevron) btn.classList.add('chevron');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.remove();
            item.onClick();
        });
        dropdown.appendChild(btn);
    }

    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.visibility = 'hidden';
    document.body.appendChild(dropdown);
    const dropH = dropdown.getBoundingClientRect().height;
    dropdown.style.top = `${rect.top - dropH - 8}px`;
    const dropW = dropdown.getBoundingClientRect().width;
    dropdown.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 8 - dropW)}px`;
    dropdown.style.visibility = '';

    const dismiss = (e: Event): void => {
        if (dropdown.contains(e.target as Node)) return;
        dropdown.remove();
        document.removeEventListener('pointerdown', dismiss, true);
    };
    setTimeout(() => {
        document.addEventListener('pointerdown', dismiss, { capture: true });
    }, 0);
}
