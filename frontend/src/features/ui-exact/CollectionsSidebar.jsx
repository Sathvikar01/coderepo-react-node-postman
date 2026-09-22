import { useState } from 'react'
import { collections } from './data'


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

function RequestItem({ req, collectionTitle, folder, onOpen }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px 5px 32px',
        background: hovered ? 'var(--panel)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        borderRadius: 4,
      }}
    >
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 500, color: methodColor(req.method), minWidth: 38 }}>
        {req.method}
      </span>
      <span style={{ color: 'var(--text)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {req.title}
      </span>
    </button>
  )
}

function FolderItem({ folder, collectionTitle, onOpenRequest }) {
  const [expanded, setExpanded] = useState(folder.expanded)
  return (
    <div>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px 5px 20px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-muted)',
          fontSize: 12,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: '0.15s' }}>
          <path d="M3 2l4 3-4 3V2z" fill="currentColor"/>
        </svg>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{folder.title}</span>
      </button>
      {expanded && folder.items.map(item => {
        if ('items' in item) return null
        const req = item as CollectionRequest
        return (
          <RequestItem
            key={req.id}
            req={req}
            collectionTitle={collectionTitle}
            folder={folder.title}
            onOpen={() => onOpenRequest(req)}
          />
        )
      })}
    </div>
  )
}

function CollectionItem({ col, onOpenRequest }) {
  const [expanded, setExpanded] = useState(col.expanded)
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: '0.15s' }}>
          <path d="M3 2l4 3-4 3V2z" fill="currentColor"/>
        </svg>
        {col.title}
      </button>
      {expanded && col.folders.map(folder => (
        <FolderItem key={folder.id} folder={folder} collectionTitle={col.title} onOpenRequest={onOpenRequest} />
      ))}
    </div>
  )
}

export default function CollectionsSidebar({ onOpenRequest }) {
  const [search, setSearch] = useState('')
  const [env] = useState('Local')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Collections</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <IconBtn title="New collection">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </IconBtn>
            <IconBtn title="More options">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/></svg>
            </IconBtn>
          </div>
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search collections…"
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

      {/* Tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {collections
          .filter(c => !search || c.title.toLowerCase().includes(search.toLowerCase()))
          .map(col => (
            <CollectionItem
              key={col.id}
              col={col}
              onOpenRequest={req => onOpenRequest(req, col)}
            />
          ))}
      </div>

      {/* Environment footer */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>Environment</div>
        <button style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 8px',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          fontSize: 12,
          cursor: 'pointer',
        }}>
          <span>{env}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )
}

function IconBtn({ children, title }) {
  return (
    <button title={title} style={{
      width: 24, height: 24,
      borderRadius: 4,
      border: 'none',
      background: 'transparent',
      color: 'var(--text-muted)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
    >
      {children}
    </button>
  )
}
