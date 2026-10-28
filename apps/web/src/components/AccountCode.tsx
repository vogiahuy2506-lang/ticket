'use client';

import { useState } from 'react';
import { shortenAccountCode } from '@tce/shared';

/**
 * An account code carries a UUID (`liability:user:<uuid>:available`), which
 * is far too long to sit under the account name on a phone. Showing it in
 * full turns the table into a wall of identifiers, so the code is shown
 * shortened (`liability:user:9babd67a…:available`).
 *
 * Clicking the code expands it in place - nothing is hidden behind a
 * navigation - and the copy button always copies the *full* code, so a
 * truncated identifier can never end up in a support ticket.
 */
export function AccountCode({
  code,
  truncate = false,
}: {
  code: string;
  /** the code is clipped to one line instead of wrapping (dense rows) */
  truncate?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const short = shortenAccountCode(code);
  const isShortened = short !== code;

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions).
      // Fall back to a selection so the user can copy by hand.
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing else we can do */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="mt-1 flex items-center gap-1.5">
      {/*
        The code is a button because it expands in place. `title` gives
        the full code as a tooltip for anyone on a desktop.
      */}
      <button
        type="button"
        onClick={() => isShortened && setExpanded((v) => !v)}
        title={isShortened && !expanded ? code : undefined}
        aria-expanded={isShortened ? expanded : undefined}
        className={`min-w-0 font-mono text-[11px] text-ink-400 ${
          isShortened ? 'cursor-pointer hover:text-ink-600' : 'cursor-default'
        } ${truncate ? 'truncate' : ''}`}
      >
        {expanded ? code : short}
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label={`Sao chép mã tài khoản ${code}`}
        title="Sao chép mã tài khoản"
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
      >
        {copied ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  );
}
