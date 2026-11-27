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
                // Some actions close before starting a navigation animation.
                if (modal.isConnected) close();
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

/** Only one action-bar dropdown can be open, including during an anchor switch. */
let closeOpenDropdown: (() => void) | undefined;

export function dismissActionDropdown(): void {
    closeOpenDropdown?.();
}

/** Mount beside the button so the caret and animation follow it through layout changes. */
export function toggleActionDropdown(
    anchor: HTMLButtonElement,
    items: Array<{ label: string; danger?: boolean; chevron?: boolean; onClick: () => void }>,
): void {
    const wasOpen = anchor.getAttribute('aria-expanded') === 'true';
    dismissActionDropdown();
    if (wasOpen) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'action-dropdown';

    // The anchor owns its click, including taps on its SVG. Every other outside
    // press dismisses without consuming the tap that selects the next row.
    const dismissOutside = (e: PointerEvent): void => {
        const target = e.target as Node;
        if (!dropdown.contains(target) && !anchor.contains(target)) dismissActionDropdown();
    };
    closeOpenDropdown = () => {
        document.removeEventListener('pointerdown', dismissOutside, true);
        anchor.setAttribute('aria-expanded', 'false');
        dropdown.remove();
        closeOpenDropdown = undefined;
    };

    for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        if (item.danger) btn.classList.add('danger');
        if (item.chevron) btn.classList.add('chevron');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismissActionDropdown();
            item.onClick();
        });
        dropdown.appendChild(btn);
    }

    anchor.after(dropdown);
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', dismissOutside, true);
}
