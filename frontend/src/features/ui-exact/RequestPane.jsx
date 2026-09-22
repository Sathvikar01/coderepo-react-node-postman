import { useState, useRef, useCallback } from 'react'
import RequestEditor from './RequestEditor'
import ResponsePanel from './ResponsePanel'
import CodeDrawer from './CodeDrawer'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

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


export default function RequestPane({ tab, onUpdate }) {
  const [method, setMethod] = useState(tab.method)
  const [url, setUrl] = useState(tab.url || 'https://api.example.com/v1/orders')
  const [showMethodMenu, setShowMethodMenu] = useState(false)
  const [sent, setSent] = useState(tab.collectionId === 'list-orders')
  const [codeOpen, setCodeOpen] = useState(false)
  const [splitPos, setSplitPos] = useState(0.45)
  const containerRef = useRef(null)
  const dragging = useRef(false)

  const handleSend = () => {
    setSent(true)
    onUpdate({ dirty: false })
  }

  const onDragStart = useCallback(() => {
    dragging.current = true
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pos = (e.clientY - rect.top) / rect.height
      setSplitPos(Math.max(0.2, Math.min(0.75, pos)))
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)', position: 'relative' }}>
      {/* Title row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px 8px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{tab.title}</div>
          {tab.collectionPath && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{tab.collectionPath}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {tab.dirty && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Unsaved</span>}
          <button style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Save</button>
          <button style={{ width: 28, height: 28, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/></svg>
          </button>
        </div>
      </div>

      {/* URL bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        {/* Method dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowMethodMenu(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 10px',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRight: 'none',
              borderRadius: '6px 0 0 6px',
              color: methodColor(method),
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              minWidth: 80,
            }}
          >
            {method}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
          {showMethodMenu && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              zIndex: 100,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
              minWidth: 100,
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            }}>
              {METHODS.map(m => (
                <button
                  key={m}
                  onClick={() => { setMethod(m); setShowMethodMenu(false); onUpdate({ method: m, dirty: true }) }}
                  style={{
                    width: '100%',
                    padding: '7px 12px',
                    background: 'transparent',
                    border: 'none',
                    color: methodColor(m),
                    cursor: 'pointer',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    fontWeight: 500,
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--panel-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* URL input */}
        <input
          value={url}
          onChange={e => { setUrl(e.target.value); onUpdate({ url: e.target.value, dirty: true }) }}
          placeholder="https://api.example.com/v1/resource"
          style={{
            flex: 1,
            padding: '7px 12px',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />

        {/* CODE button */}
        <button
          onClick={() => setCodeOpen(true)}
          style={{
            padding: '7px 12px',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderLeft: 'none',
            borderRight: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.5,
          }}
        >
          CODE
        </button>

        {/* SEND button */}
        <button
          onClick={handleSend}
          style={{
            padding: '7px 20px',
            background: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: '0 6px 6px 0',
            color: 'var(--accent-fg)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
        >
          SEND
        </button>
      </div>

      {/* Split: editor + response */}
      <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Request editor */}
        <div style={{ height: `${splitPos * 100}%`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <RequestEditor />
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={onDragStart}
          style={{
            height: 5,
            background: 'var(--border)',
            cursor: 'row-resize',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: 32, height: 2, background: 'var(--text-dim)', borderRadius: 1 }} />
        </div>

        {/* Response panel */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ResponsePanel sent={sent} />
        </div>
      </div>

      {/* Code drawer */}
      {codeOpen && <CodeDrawer method={method} url={url} onClose={() => setCodeOpen(false)} />}

      {/* Method menu backdrop */}
      {showMethodMenu && (
        <div onClick={() => setShowMethodMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
      )}
    </div>
  )
}
