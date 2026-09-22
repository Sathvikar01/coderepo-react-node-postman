

import { TracerSymbol } from '../../../shared/components/TracerBrand.jsx'

const navItems = [
  {
    id: 'collections',
    label: 'Collections',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="9" cy="9" r="3" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M9 5v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: 'runner',
    label: 'Runner',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M5 3.5l10 5.5-10 5.5V3.5z" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: 'recorder',
    label: 'Flight Recorder',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="3" y="3" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" transform="rotate(45 9 9)"/>
      </svg>
    ),
  },
]

export default function IconRail({ active, onSelect }) {
  return (
    <div style={{
      width: 56,
      background: 'var(--bg)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '12px 0',
      flexShrink: 0,
      zIndex: 10,
    }}>
      {/* Logo */}
      <div style={{
        width: 32,
        height: 32,
        background: 'var(--accent)',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
        cursor: 'default',
      }}>
        <TracerSymbol size={22} />
      </div>

      {/* Nav items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            title={item.label}
            style={{
              position: 'relative',
              width: 40,
              height: 40,
              borderRadius: 8,
              border: 'none',
              background === item.id ? 'var(--panel)' : 'transparent',
              color === item.id ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              if (active !== item.id) (e.currentTarget).style.color = 'var(--text)'
            }}
            onMouseLeave={e => {
              if (active !== item.id) (e.currentTarget).style.color = 'var(--text-muted)'
            }}
          >
            {active === item.id && (
              <div style={{
                position: 'absolute',
                left: -4,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 3,
                height: 16,
                background: 'var(--accent)',
                borderRadius: '0 2px 2px 0',
              }} />
            )}
            {item.icon}
          </button>
        ))}
      </div>

      {/* Settings at bottom */}
      <button
        onClick={() => onSelect('settings')}
        title="Settings"
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          border: 'none',
          background === 'settings' ? 'var(--panel)' : 'transparent',
          color === 'settings' ? 'var(--accent)' : 'var(--text-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          if (active !== 'settings') (e.currentTarget).style.color = 'var(--text)'
        }}
        onMouseLeave={e => {
          if (active !== 'settings') (e.currentTarget).style.color = 'var(--text-muted)'
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.4 3.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 3.4l-1.4 1.4M4.8 13.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  )
}
