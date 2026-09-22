import { useState } from 'react'
import { environments } from './data'

export default function SettingsView() {
  const [envs, setEnvs] = useState(environments)
  const [selectedId, setSelectedId] = useState(environments[0].id)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  const selected = envs.find(e => e.id === selectedId) || envs[0]

  const updateVar = (varId, updates) => {
    setEnvs(es => es.map(env =>
      env.id !== selectedId ? env : {
        ...env,
        variables: env.variables.map(v => v.id === varId ? { ...v, ...updates } : v),
      }
    ))
  }

  const addVar = () => {
    setEnvs(es => es.map(env =>
      env.id !== selectedId ? env : {
        ...env,
        variables: [...env.variables, { id: `v${Date.now()}`, name: '', type: 'plain', value: '' }],
      }
    ))
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Env list */}
      <div style={{ width: 200, borderRight: '1px solid var(--border)', padding: '16px 0' }}>
        <div style={{ padding: '0 12px', fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Environments</div>
        {envs.map(env => (
          <button
            key={env.id}
            onClick={() => setSelectedId(env.id)}
            style={{
              width: '100%',
              padding: '7px 12px',
              background === env.id ? 'var(--panel)' : 'transparent',
              border: 'none',
              borderLeft === env.id ? '2px solid var(--accent)' : '2px solid transparent',
              color === env.id ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 13,
            }}
          >
            {env.name}
          </button>
        ))}
        <button
          style={{ width: '100%', padding: '7px 12px', background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          New environment
        </button>
      </div>

      {/* Env editor */}
      <div style={{ flex: 1, padding: '16px 24px', overflowY: 'auto' }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{selected.name}</h2>

        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr 32px', gap: 12, marginBottom: 6 }}>
          {['Variable', 'Type', 'Value', ''].map(h => (
            <span key={h} style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-dim)' }}>{h}</span>
          ))}
        </div>

        {/* Rows */}
        {selected.variables.map(v => (
          <div key={v.id} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr 32px', gap: 12, marginBottom: 4, alignItems: 'center' }}>
            <input
              value={v.name}
              onChange={e => updateVar(v.id, { name: e.target.value })}
              style={{ padding: '6px 8px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, outline: 'none', width: '100%' }}
            />
            <select
              value={v.type}
              onChange={e => updateVar(v.id, { type: e.target.value as 'plain' | 'secret' })}
              style={{ padding: '6px 8px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 12, outline: 'none', width: '100%', cursor: 'pointer' }}
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            <div style={{ position: 'relative' }}>
              <input
                type={v.type === 'secret' && !showSecrets[v.id] ? 'password' : 'text'}
                value={v.value}
                onChange={e => updateVar(v.id, { value: e.target.value })}
                style={{ padding: '6px 8px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, outline: 'none', width: '100%', paddingRight === 'secret' ? 28 : 8 }}
              />
              {v.type === 'secret' && (
                <button
                  onClick={() => setShowSecrets(s => ({ ...s, [v.id]: !s[v.id] }))}
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                  title={showSecrets[v.id] ? 'Hide' : 'Reveal'}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    {showSecrets[v.id]
                      ? <><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1.2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></>
                      : <><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1.2"/><path d="M1 1l12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></>
                    }
                  </svg>
                </button>
              )}
            </div>
            <button
              style={{ width: 28, height: 28, background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4 }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--status-5xx)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        ))}

        <button
          onClick={addVar}
          style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          Add variable
        </button>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <button style={{ padding: '7px 16px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button style={{ padding: '7px 16px', border: 'none', borderRadius: 4, background: 'var(--accent)', color: 'var(--accent-fg)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  )
}
