import { useEffect, useState } from 'react';
import { Modal } from './widgets';
import { useAsk } from './askState';

/** Modal for askConfirm / askText (see askState.ts). */
export function AskDialog() {
  const ask = useAsk((s) => s.ask);
  const [value, setValue] = useState('');
  useEffect(() => setValue(ask?.value ?? ''), [ask]);
  if (!ask) return null;
  const done = (r: string | null) => {
    useAsk.setState({ ask: null });
    ask.resolve(r);
  };
  return (
    <Modal
      title={ask.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="secondary-btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="primary-btn" autoFocus={ask.kind === 'confirm'} onClick={() => done(ask.kind === 'prompt' ? value : '')}>
            {ask.ok}
          </button>
        </>
      }
    >
      <p>{ask.text}</p>
      {ask.kind === 'prompt' && (
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done(value);
            if (e.key === 'Escape') done(null);
          }}
          aria-label={ask.title}
          style={{ width: '100%' }}
        />
      )}
    </Modal>
  );
}
