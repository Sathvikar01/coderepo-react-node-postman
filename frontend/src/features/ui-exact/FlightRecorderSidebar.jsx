import { recorderExecutions } from './data'


function statusColor(status) {
  if (status >= 200 && status < 300) return 'var(--status-2xx)'
  if (status >= 400 && status < 500) return 'var(--status-4xx)'
  return 'var(--status-5xx)'
}

export default function FlightRecorderSidebar({ selectedId, onSelect }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Executions</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {recorderExecutions.map(exec => (
          <button
            key={exec.id}
            onClick={() => onSelect(exec)}
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
              gap: 3,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>{exec.success ? '○' : '●'}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 500, color: statusColor(exec.status) }}>{exec.success ? 'Success' : 'Failed'} {exec.status}</span>
            </div>
            <div style={{ paddingLeft: 20, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>
              {exec.method} {exec.path}
            </div>
            <div style={{ paddingLeft: 20, fontSize: 11, color: 'var(--text-dim)' }}>{exec.time}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
