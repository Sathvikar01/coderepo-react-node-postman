

function methodColor(m) {
  const map = {
    GET: 'var(--method-get)',
    POST: 'var(--method-post)',
    PUT: 'var(--method-put)',
    PATCH: 'var(--method-patch)',
    DELETE: 'var(--method-delete)',
  }
  return map[m]
}

export default function RequestTabs({ tabs, activeId, onSelect, onClose, onNew }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      flexShrink: 0,
      height: 38,
    }}>
      {tabs.map(tab => {
        const isActive = tab.id === activeId
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              cursor: 'pointer',
              borderRight: '1px solid var(--border)',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              background: isActive ? 'var(--panel)' : 'transparent',
              color: isActive ? 'var(--text)' : 'var(--text-muted)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              minWidth: 120,
              maxWidth: 200,
              transition: 'background 0.1s',
            }}
          >
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: methodColor(tab.method), fontWeight: 500 }}>
              {tab.method.slice(0, 3)}
            </span>
            <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{tab.title}</span>
            {tab.dirty && <span style={{ color: 'var(--accent)', fontSize: 14, lineHeight: 1 }}>●</span>}
            <button
              onClick={e => { e.stopPropagation(); onClose(tab.id) }}
              style={{
                width: 16, height: 16,
                borderRadius: 3,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                flexShrink: 0,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )
      })}
      <button
        onClick={onNew}
        title="New request"
        style={{
          padding: '0 12px',
          border: 'none',
          background: 'transparent',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
      >
        +
      </button>
    </div>
  )
}
