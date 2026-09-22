import { useState } from 'react'


const TABS = [
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'auth', label: 'Auth' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'tests', label: 'Tests' },
]

const defaultParams = [
  { id: 'p1', enabled: true, key: 'status', value: 'paid' },
  { id: 'p2', enabled: false, key: 'limit', value: '20' },
]

function ParamRow({ param, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: 8, padding: '4px 0', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)' }}>
      <input
        type="checkbox"
        checked={param.enabled}
        onChange={e => onChange({ ...param, enabled: e.target.checked })}
        style={{ accentColor: 'var(--accent)' }}
      />
      <input
        value={param.key}
        onChange={e => onChange({ ...param, key: e.target.value })}
        placeholder="key"
        style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '2px 0' }}
      />
      <input
        value={param.value}
        onChange={e => onChange({ ...param, value: e.target.value })}
        placeholder="value"
        style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '2px 0' }}
      />
    </div>
  )
}

function ParamsPanel() {
  const [params, setParams] = useState(defaultParams)
  const update = (updated) => setParams(ps => ps.map(p => p.id === updated.id ? updated : p))
  const addParam = () => setParams(ps => [...ps, { id: `p${Date.now()}`, enabled: true, key: '', value: '' }])

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: 8, marginBottom: 4 }}>
        <div />
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Key</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Value</span>
      </div>
      {params.map(p => <ParamRow key={p.id} param={p} onChange={update} />)}
      <button
        onClick={addParam}
        style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        Add parameter
      </button>
    </div>
  )
}

function HeadersPanel() {
  const [headers, setHeaders] = useState([
    { id: 'h1', enabled: true, key: 'Accept', value: 'application/json' },
    { id: 'h2', enabled: true, key: 'Authorization', value: 'Bearer {{orders_token}}' },
  ])
  const update = (updated: any) => setHeaders(hs => hs.map(h => h.id === updated.id ? updated : h))
  const addHeader = () => setHeaders(hs => [...hs, { id: `h${Date.now()}`, enabled: true, key: '', value: '' }])

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: 8, marginBottom: 4 }}>
        <div />
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Key</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Value</span>
      </div>
      {headers.map(h => (
        <div key={h.id} style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: 8, padding: '4px 0', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)' }}>
          <input type="checkbox" checked={h.enabled} onChange={e => update({ ...h, enabled: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />
          <input value={h.key} onChange={e => update({ ...h, key: e.target.value })} style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '2px 0' }} />
          <input value={h.value} onChange={e => update({ ...h, value: e.target.value })} style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '2px 0' }} />
        </div>
      ))}
      <button onClick={addHeader} style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        Add header
      </button>
    </div>
  )
}

const BODY_TYPES = ['None', 'JSON', 'Text', 'Form']

function BodyPanel() {
  const [bodyType, setBodyType] = useState('JSON')
  const [body, setBody] = useState('{\n  "customer": "Ada",\n  "items": [\n    { "sku": "ORD-001", "qty": 2 }\n  ]\n}')

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {BODY_TYPES.map(t => (
          <button
            key={t}
            onClick={() => setBodyType(t)}
            style={{
              padding: '4px 10px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background === t ? 'var(--panel-2)' : 'transparent',
              color === t ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {bodyType !== 'None' && (
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            height: 160,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            color: 'var(--text)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            resize: 'vertical',
            outline: 'none',
          }}
        />
      )}
    </div>
  )
}

const AUTH_TYPES = ['None', 'Bearer', 'Basic', 'API Key', 'Inherit from collection']

function AuthPanel() {
  const [authType, setAuthType] = useState('Bearer')
  const [token, setToken] = useState('{{orders_token}}')

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Authentication</div>
        {AUTH_TYPES.map(t => (
          <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', color === t ? 'var(--text)' : 'var(--text-muted)', fontSize: 12 }}>
            <input
              type="radio"
              name="auth"
              checked={authType === t}
              onChange={() => setAuthType(t)}
              style={{ accentColor: 'var(--accent)' }}
            />
            {t}
          </label>
        ))}
      </div>

      {authType === 'Bearer' && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>Token</div>
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '7px 10px',
              color: 'var(--text)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
            Resolved from environment · Local / orders_token
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyPanel({ label }) {
  return (
    <div style={{ padding: '24px 16px', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>
      No {label.toLowerCase()} configured
    </div>
  )
}

export default function RequestEditor() {
  const [active, setActive] = useState('params')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Tab row */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color === tab.id ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight === tab.id ? 500 : 400,
              transition: 'all 0.1s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {active === 'params' && <ParamsPanel />}
        {active === 'headers' && <HeadersPanel />}
        {active === 'body' && <BodyPanel />}
        {active === 'auth' && <AuthPanel />}
        {active === 'scripts' && <EmptyPanel label="Scripts" />}
        {active === 'tests' && <EmptyPanel label="Tests" />}
      </div>
    </div>
  )
}
