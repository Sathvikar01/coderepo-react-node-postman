import { useState } from 'react'


const initialSteps = [
  { name: 'List orders', method: 'GET', status: 200, ms: 82, state: 'pass' },
  { name: 'Get order', method: 'GET', status: 200, ms: 71, state: 'pass' },
  { name: 'Create order', method: 'POST', status: 422, ms: 45, state: 'fail' },
  { name: 'Update order', method: 'PATCH', state: 'skipped' },
  { name: 'Delete order', method: 'DELETE', state: 'skipped' },
]

function statusColor(status?) {
  if (!status) return 'var(--text-dim)'
  if (status >= 200 && status < 300) return 'var(--status-2xx)'
  if (status >= 400 && status < 500) return 'var(--status-4xx)'
  return 'var(--status-5xx)'
}

function StateIcon({ state }) {
  if (state === 'pass') return <span style={{ color: 'var(--status-2xx)', fontSize: 14 }}>✓</span>
  if (state === 'fail') return <span style={{ color: 'var(--status-4xx)', fontSize: 14 }}>✕</span>
  return <span style={{ color: 'var(--text-dim)', fontSize: 14 }}>○</span>
}

export default function RunnerView() {
  const [ran, setRan] = useState(true)
  const [env] = useState('Local')

  return (
    <div style={{ padding: '24px 32px', maxWidth: 720, margin: '0 auto' }}>
      {/* Config */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Run Collection</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Collection</label>
            <div style={{ padding: '7px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }}>Orders API</div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Environment</label>
            <button style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
              <span>{env}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Iterations</label>
            <input type="number" defaultValue={1} min={1} style={{ width: '100%', padding: '7px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, outline: 'none' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>On failure</label>
            <button style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
              <span>Stop</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
        <button
          onClick={() => setRan(true)}
          style={{
            padding: '10px 28px',
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            color: 'var(--accent-fg)',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
            letterSpacing: 0.5,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
        >
          RUN COLLECTION
        </button>
      </div>

      {ran && (
        <>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>RUNNING</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--status-4xx)' }}>3 / 5</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>· Stopped after failure</span>
            </div>

            {/* Step results */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {initialSteps.map((step, i) => (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr 80px 60px',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  background === 'fail' ? 'rgba(248,81,73,0.06)' : 'var(--panel)',
                  borderRadius: 4,
                  border === 'fail' ? '1px solid rgba(248,81,73,0.2)' : '1px solid transparent',
                }}>
                  <StateIcon state={step.state} />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-muted)' }}>{step.method}</span>
                    <span style={{ fontSize: 12, color: 'var(--text)' }}>{step.name}</span>
                  </div>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: statusColor(step.status) }}>
                    {step.status || '—'}
                  </span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                    {step.ms ? `${step.ms} ms` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Summary */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Assertions: <span style={{ color: 'var(--status-2xx)' }}>2 passed</span> · <span style={{ color: 'var(--status-4xx)' }}>1 failed</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>View failed request</button>
              <button style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>Open Passport</button>
              <button style={{ padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 4, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>Run again</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
