import { useState } from 'react';
import { LoaderCircle, Send } from 'lucide-react';
import { Dialog } from '../dialog';
import { agentsConnection } from '../../agents/connection';
import type { ThreadShell } from '../../agents/types';
import { useTranslation } from '../../i18n';

// Focusing the field brings up the TV keyboard, whose mic button dictates on
// LG and Fire TV remotes, so this covers voice replies too.
export function ReplyDialog({
  thread,
  onClose,
  notify,
}: {
  thread: ThreadShell;
  onClose: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await agentsConnection().send(thread.id, message);
      notify(t('agentReplySent'));
      onClose();
    } catch {
      notify(t('agentActionFailed'), true);
      setSending(false);
    }
  };
  return (
    <Dialog title={t('agentReplyTitle')} subtitle={thread.title} onClose={onClose} wide>
      <form
        className="reply-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="search-field reply-field">
          <input
            data-focusable="reply-text"
            data-autofocus
            aria-label={t('agentReplyPrompt')}
            placeholder={t('agentReplyPlaceholder')}
            value={text}
            maxLength={4000}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          className="primary-button"
          type="submit"
          data-focusable="reply-send"
          disabled={!text.trim() || sending}
        >
          {sending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
          {t('agentSend')}
        </button>
      </form>
    </Dialog>
  );
}
