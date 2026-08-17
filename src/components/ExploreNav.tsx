import type { OmmRecord } from '../lib/types'

interface ExploreNavProps {
  query: string
  entries: OmmRecord[]
  onQueryChange: (query: string) => void
  onSelect: (catalogId: number) => void
  onClose: () => void
}

export function ExploreNav({ query, entries, onQueryChange, onSelect, onClose }: ExploreNavProps) {
  return <section className="explore-nav glass">
    <div className="explore-nav-heading"><span className="panel-title">Navegação</span><button className="close-button" onClick={onClose} aria-label="Fechar navegação">×</button></div>
    <input autoFocus aria-label="Pesquisa da navegação" placeholder="Pesquisar satélites ou ID NORAD…" value={query} onChange={(event) => onQueryChange(event.target.value)} />
    <div className="explore-nav-list">
      {entries.slice(0, 10).map((entry) => <button key={entry.NORAD_CAT_ID} onClick={() => onSelect(entry.NORAD_CAT_ID)}>
        <strong>{entry.OBJECT_NAME}</strong>
        <span>NORAD {entry.NORAD_CAT_ID} · {entry.OBJECT_TYPE}</span>
      </button>)}
      {!entries.length && <p>Nenhum objeto orbital corresponde à pesquisa.</p>}
    </div>
    <small className="explore-nav-hint">O universo continua se movendo · Esc para fechar</small>
  </section>
}
