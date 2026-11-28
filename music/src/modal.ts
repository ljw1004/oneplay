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

export interface ActionDropdownItem {
    label: string;
    danger?: boolean;
    onClick: () => void;
}

/** The row is measured in the tree after entering selection. */
interface RowActionAnchor {
    getRow: () => Element | null;
    actionBar: HTMLElement;
    scroller: HTMLElement;
}

/** Only one dropdown can be open, including during an anchor switch. */
let closeOpenDropdown: (() => void) | undefined;

export function dismissActionDropdown(): void {
    closeOpenDropdown?.();
}

/** Mount next to a bar button or at the pressed row in the visible tree. */
export function toggleActionDropdown(
    anchor: HTMLButtonElement | RowActionAnchor,
    items: ActionDropdownItem[],
    dividerBefore = 0,
): void {
    const button = anchor instanceof HTMLButtonElement ? anchor : undefined;
    const wasOpen = button?.getAttribute('aria-expanded') === 'true';
    dismissActionDropdown();
    if (wasOpen) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'action-dropdown';
    const lifetime = new AbortController();
    const {signal} = lifetime;
    closeOpenDropdown = () => {
        lifetime.abort();
        button?.setAttribute('aria-expanded', 'false');
        dropdown.remove();
        closeOpenDropdown = undefined;
    };

    for (const [index, item] of items.entries()) {
        if (index > 0 && index === dividerBefore) dropdown.append(document.createElement('hr'));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        if (item.danger) btn.classList.add('danger');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismissActionDropdown();
            item.onClick();
        });
        dropdown.appendChild(btn);
    }

    if (anchor instanceof HTMLButtonElement) {
        anchor.after(dropdown);
        anchor.setAttribute('aria-expanded', 'true');
    } else {
        dropdown.classList.add('row-action-dropdown');
        document.body.append(dropdown);
        const position = (): void => {
            const row = anchor.getRow();
            if (row) positionRowActionDropdown(dropdown, anchor, row.getBoundingClientRect());
            else dismissActionDropdown();
        };
        position();
        const openedAtScrollTop = anchor.scroller.scrollTop;
        // Entering selection can queue a scroll event before the menu opens.
        anchor.scroller.addEventListener('scroll', () => {
            if (anchor.scroller.scrollTop !== openedAtScrollTop) dismissActionDropdown();
        }, {signal});
        window.addEventListener('resize', position, {signal});
        window.visualViewport?.addEventListener('resize', position, {signal});
        window.visualViewport?.addEventListener('scroll', position, {signal});
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) dismissActionDropdown();
        }, {signal});
    }
    // Leave outside taps to their targets. A bar button still owns toggling its own menu.
    document.addEventListener('pointerdown', event => {
        const target = event.target as Node;
        if (!dropdown.contains(target) && !button?.contains(target)) dismissActionDropdown();
    }, {capture: true, signal});
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') dismissActionDropdown();
    }, {signal});
}

/** Keep the menu within the safe area and the bottom bar tappable, even in landscape. */
function positionRowActionDropdown(dropdown: HTMLElement, {actionBar, scroller}: RowActionAnchor, row: DOMRect): void {
    const viewportInset = 8;
    const rowGap = 4;
    const bar = actionBar.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const left = Math.max(bar.left, viewportLeft) + viewportInset;
    const right = Math.min(bar.right, viewportLeft + (viewport?.width ?? window.innerWidth)) - viewportInset;
    const top = Math.max(scroller.parentElement!.getBoundingClientRect().top, viewportTop) + viewportInset;
    const bottom = Math.min(bar.top, viewportTop + (viewport?.height ?? window.innerHeight)) - viewportInset;
    const above = Math.max(0, Math.min(bottom, row.top - rowGap) - top);
    const below = Math.max(0, bottom - Math.max(top, row.bottom + rowGap));
    dropdown.style.maxWidth = `${right - left}px`;
    const {offsetWidth, scrollHeight} = dropdown;
    // Use the larger side only when the full menu cannot open below.
    const opensAbove = scrollHeight > below && above > below;
    const available = opensAbove ? above : below;
    dropdown.style.maxHeight = `${available}px`;
    dropdown.style.setProperty('--row-menu-min-left', `${left}px`);
    dropdown.style.setProperty('--row-menu-max-left', `${right - offsetWidth}px`);
    dropdown.style.top = `${opensAbove ? top + above - Math.min(scrollHeight, available) : bottom - below}px`;
    dropdown.classList.toggle('opens-above', opensAbove);
}
