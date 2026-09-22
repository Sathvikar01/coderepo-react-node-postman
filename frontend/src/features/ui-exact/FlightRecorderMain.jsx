import { useState } from 'react'
import { recorderExecutions } from './data'


const INV_TABS = [
  { id: 'passport', label: 'Passport' },
  { id: 'compare', label: 'Compare' },
  { id: 'minimize', label: 'Minimize' },
  { id: 'capsule', label: 'Capsule' },
]

function statusColor(status) {
  if (status >= 200 && status < 300) return 'var(--status-2xx)'
  if (status >= 400 && status < 500) return 'var(--status-4xx)'
  return 'var(--status-5xx)'
}

function PassportTab() {
  const rows = [
    { key: 'Request revision', value: 'r18' },
    { key: 'Environment', value: 'Local / r7' },
    { key: 'Auth', value: 'Bearer → orders_token' },
    { key: 'DNS', value: '127.0.0.1' },
    { key: 'Policy', value: 'Allowed' },
    { key: 'Response', value: '401 Unauthorized' },
    { key: 'Duration', value: '31 ms' },
    { key: 'Timestamp', value: '10:39:42 PM' },
  ]
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>Execution Passport</div>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.key}</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--text)' }}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function CompareTab() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>Compare Executions</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'A', desc: 'Success · 200 · 10:37' },
          { label: 'B', desc: 'Failed · 401 · 10:39' },
        ].map(e => (
          <div key={e.label} style={{ flex: 1, padding: '8px 12px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 14, color: 'var(--accent)' }}>{e.label}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.desc}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>First Meaningful Divergence</div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Environment</div>
        <div style={{ padding: '8px 12px' }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--status-2xx)', marginBottom: 4 }}>A: orders_token → local_token</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--status-4xx)' }}>B: orders_token → staging_token</div>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Other differences</div>
        {['Request', 'DNS', 'Policy', 'Scripts'].map(k => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, padding: '4px 0', fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ color: 'var(--text-dim)' }}>identical</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MinimizeTab() {
  const [progress] = useState(7)
  const total = 9
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>Failure Minimizer</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Original request · 6 removable inputs</div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Progress</div>
        <div style={{ height: 6, background: 'var(--panel)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(progress / total) * 100}%`, background: 'var(--accent)', borderRadius: 3 }} />
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Removed</div>
        {['query: debug', 'header: X-Debug', 'body field: metadata'].map(item => (
          <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12, color: 'var(--text-dim)' }}>
            <span style={{ color: 'var(--status-2xx)' }}>✓</span> {item}
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Required to reproduce</div>
        {['Authorization', 'URL'].map(item => (
          <div key={item} style={{ padding: '3px 0', fontSize: 12, color: 'var(--text)' }}>{item}</div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Smallest reproducer found</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>Open request</button>
          <button style={{ padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 4, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>Export Capsule</button>
        </div>
      </div>
    </div>
  )
}

function CapsuleTab() {
  const [copied, setCopied] = useState(false)
  const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>Reproduction Capsule</div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>GET /v1/orders</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Environment context included</span>
          <span>Secrets redacted</span>
          <span>3 required inputs</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={copy} style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: copied ? 'var(--status-2xx)' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
          {copied ? 'Copied!' : 'Copy JSON'}
        </button>
        <button style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>Export</button>
        <button style={{ padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent)', color: 'var(--accent-fg)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Open as Draft</button>
      </div>
    </div>
  )
}

export default function FlightRecorderMain() {
  const [selectedId, setSelectedId] = useState(recorderExecutions[0].id)
  const [invTab, setInvTab] = useState('passport')
  const selected = recorderExecutions.find(e => e.id === selectedId) || recorderExecutions[0]

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Executions list */}
      <div style={{ width: 260, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Executions</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {recorderExecutions.map(exec => (
            <button
              key={exec.id}
              onClick={() => setSelectedId(exec.id)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background === exec.id ? 'var(--panel)' : 'transparent',
                border: 'none',
                borderLeft === exec.id ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10 }}>{exec.success ? '○' : '●'}</span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 500, color: statusColor(exec.status) }}>
                  {exec.success ? 'Success' : 'Failed'} {exec.status}
                </span>
              </div>
              <div style={{ paddingLeft: 16, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>
                {exec.method} {exec.path}
              </div>
              <div style={{ paddingLeft: 16, fontSize: 11, color: 'var(--text-dim)' }}>{exec.time}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Investigation */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>Investigation</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
              {selected.success ? '' : 'Failed request · '}{selected.method} {selected.path}
            </span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: statusColor(selected.status) }}>
              {selected.status} {selected.success ? 'OK' : 'Unauthorized'}
            </span>
          </div>
        </div>

        {/* Investigation tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {INV_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setInvTab(tab.id)}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderBottom === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
                color === tab.id ? 'var(--text)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight === tab.id ? 500 : 400,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {invTab === 'passport' && <PassportTab />}
          {invTab === 'compare' && <CompareTab />}
          {invTab === 'minimize' && <MinimizeTab />}
          {invTab === 'capsule' && <CapsuleTab />}
        </div>
      </div>
    </div>
  )
}
