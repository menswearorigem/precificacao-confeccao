import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, ShieldQuestion } from 'lucide-react';
import { api } from '../api/client';
import { pct, formatQtd } from '../lib/format';
import { Select, Skeleton } from '../components/ui';

function GrupoAlerta({ grupo }) {
  if (grupo.total === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <AlertTriangle size={14} /> {grupo.titulo} ({formatQtd(grupo.total)})
      </div>
      <p className="page-sub" style={{ margin: '0 0 8px' }}>Limite configurado: {pct(grupo.limite)}.</p>
      <table className="data-table">
        <thead><tr><th>Referência</th><th>Descrição</th><th>Apurado</th><th>Desvio</th><th /></tr></thead>
        <tbody>
          {grupo.referencias.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.referencia}</td>
              <td>{r.descricao || '—'}</td>
              <td className="mono">{r.valorApurado !== null ? pct(r.valorApurado) : '—'}</td>
              <td className="mono">{r.desvio !== null ? <span className="stamp sm tone-prejuizo">+{pct(r.desvio)}</span> : '—'}</td>
              <td style={{ textAlign: 'right' }}><Link to={`/produtos/${r.id}`} className="icon-btn"><ChevronRight size={16} /></Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AlertasPage() {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [empresas, setEmpresas] = useState([]);
  const [listas, setListas] = useState(null);
  const [empresaId, setEmpresaId] = useState('');
  const [marca, setMarca] = useState('');
  const [categoria, setCategoria] = useState('');

  useEffect(() => {
    Promise.all([api.get('/empresas'), api.get('/listas')]).then(([e, l]) => {
      setEmpresas(e);
      setListas(l);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (empresaId) params.set('empresa_id', empresaId);
    if (marca) params.set('marca', marca);
    if (categoria) params.set('categoria', categoria);
    api.get(`/alertas?${params.toString()}`).then(setDados).finally(() => setLoading(false));
  }, [empresaId, marca, categoria]);

  const grupos = useMemo(() => (dados ? Object.values(dados.grupos) : []), [dados]);
  const totalComAlerta = useMemo(() => grupos.reduce((s, g) => s + g.total, 0), [grupos]);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2><AlertTriangle size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Central de Alertas</h2>
          <p className="page-sub">Quais referências estão fora de cada limite configurado em Parâmetros, agora.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">Todas as empresas</option>
            {empresas.map((e) => (<option key={e.id} value={e.id}>{e.nome}</option>))}
          </Select>
          <Select value={marca} onChange={(e) => setMarca(e.target.value)} style={{ minWidth: 130 }}>
            <option value="">Todas as marcas</option>
            {(listas?.marca || []).map((m) => (<option key={m.id} value={m.valor}>{m.valor}</option>))}
          </Select>
          <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">Todas as categorias</option>
            {(listas?.categoria || []).map((c) => (<option key={c.id} value={c.valor}>{c.valor}</option>))}
          </Select>
        </div>
      </div>

      {loading && (
        <div className="card" style={{ marginTop: 16 }}>
          <Skeleton width="50%" height={16} style={{ marginBottom: 10 }} />
          <Skeleton width="70%" />
        </div>
      )}

      {!loading && dados && (
        <>
          <div className="stamp-row" style={{ marginTop: 16, marginBottom: 16 }}>
            <span className={'stamp ' + (totalComAlerta === 0 ? 'tone-saudavel' : 'tone-atencao')}>
              {formatQtd(dados.comAlerta)} de {formatQtd(dados.avaliadas)} referências avaliadas com pelo menos um alerta
            </span>
            {dados.naoAvaliavelMateriais.length > 0 && (
              <span className="stamp tone-neutro">
                <ShieldQuestion size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                {formatQtd(dados.naoAvaliavelMateriais.length)} não avaliável — falta custo de material
              </span>
            )}
          </div>

          {grupos.map((g) => (<GrupoAlerta key={g.titulo} grupo={g} />))}

          {dados.naoAvaliavelMateriais.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Não avaliável — falta custo de material ({formatQtd(dados.naoAvaliavelMateriais.length)})</div>
              <p className="page-sub" style={{ margin: '0 0 8px' }}>
                Têm material cadastrado (com quantidade), mas valor unitário zerado — o % de materiais sobre o custo
                não pode ser calculado de verdade, então não entram no grupo "Materiais acima do limite" (mostrar
                "0%, dentro do limite" aqui seria uma aprovação falsa).
              </p>
              <table className="data-table">
                <tbody>
                  {dados.naoAvaliavelMateriais.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.referencia}</td>
                      <td>{r.descricao || '—'}</td>
                      <td style={{ textAlign: 'right' }}><Link to={`/produtos/${r.id}`} className="icon-btn"><ChevronRight size={16} /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalComAlerta === 0 && dados.naoAvaliavelMateriais.length === 0 && (
            <div className="card" style={{ textAlign: 'center', padding: '32px 16px' }}>
              <p style={{ color: 'var(--ink-soft)' }}>Nenhuma referência fora dos limites configurados agora.</p>
            </div>
          )}

          <p className="page-sub" style={{ marginTop: 8 }}>
            {formatQtd(dados.total - dados.avaliadas)} de {formatQtd(dados.total)} referências não têm nenhum custo
            cadastrado ainda (nem material, nem industrial) — não entram em nenhum grupo acima.
            <Link to="/qualidade-dados" className="login-link" style={{ marginLeft: 6 }}>ver auditoria completa</Link>
          </p>
        </>
      )}
    </div>
  );
}
