import { useState } from 'react'
import { historyEntries } from './data'


function statusColor(status) {
  if (status >= 200 && status < 300) return 'var(--status-2xx)'
  if (status >= 400 && status < 500) return 'var(--status-4xx)'
  return 'var(--status-5xx)'
}

export default function HistorySidebar({ onSelect, selectedId }) {
  const [search, setSearch] = useState('')

  const filtered = historyEntries.filter(e =>
    !search || e.path.toLowerCase().includes(search.toLowerCase()) || e.method.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>History</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search executions…"
          style={{
            width: '100%',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '5px 8px',
            color: 'var(--text)',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        <div style={{ padding: '4px 12px 6px', fontSize: 10, fontWeight: 600, letterSpacing: 0.6, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Today</div>
        {filtered.map(entry => (
          <button
            key={entry.id}
            onClick={() => onSelect(entry)}
            style={{
              width: '100%',
              padding: '8px 12px',
              background === entry.id ? 'var(--panel)' : 'transparent',
              border: 'none',
              borderLeft === entry.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 8, height: 8,
                borderRadius: '50%',
                background: statusColor(entry.status),
                flexShrink: 0,
              }} />
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 500, color: statusColor(entry.status) }}>{entry.status}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-muted)' }}>{entry.method}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.path}</span>
            </div>
            <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--text-dim)' }}>
              {entry.ms} ms · {entry.env} · {entry.time}
              {entry.collection && <span> · {entry.collection}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
