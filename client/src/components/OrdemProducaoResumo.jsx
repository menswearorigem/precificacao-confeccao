import { Link } from 'react-router-dom';
import { Factory, RefreshCw, Lock } from 'lucide-react';
import { dataBr } from '../lib/format';

// Painel "Ordem de produção" dentro do evento do calendário (16/09/2026).
// O evento nasce e é atualizado pela OP (ver server/src/lib/producaoCalendario.js);
// aqui só se MOSTRA o que a OP diz. Prazo, situação e grade não se editam no
// calendário — mudam na OP (ou no Wik, enquanto a OP sincroniza).

const COR_SITUACAO = {
  rascunho: '#6b6f76',
  planejada: '#1565c0',
  em_producao: '#ef6c00',
  concluida: '#2e7d32',
  cancelada: '#b71c1c',
};

function n(v) {
  return Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function Dado({ rotulo, children }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div className="op-cal-dado">
      <span className="op-cal-rotulo">{rotulo}</span>
      <span className="op-cal-valor">{children}</span>
    </div>
  );
}

export default function OrdemProducaoResumo({ ordemId, dados }) {
  const d = dados || {};
  const porCor = Array.isArray(d.grade_por_cor) ? d.grade_por_cor : [];
  const tamanhos = Array.isArray(d.tamanhos) ? d.tamanhos : [];
  const detalhe = Array.isArray(d.grade_detalhe) ? d.grade_detalhe : [];
  const celula = (cor, tam) => detalhe
    .filter((l) => (l.cor || '(sem cor)') === cor && l.tamanho === tam)
    .reduce((s, l) => s + Number(l.planejada || 0), 0);

  return (
    <div className="card op-cal" style={{ marginBottom: 12 }}>
      <div className="op-cal-topo">
        <div className="op-cal-titulo">
          <Factory size={15} />
          <span>OP <span className="mono">{d.numero_op || '—'}</span></span>
          <span className="op-cal-chip" style={{ background: COR_SITUACAO[d.situacao_op] || '#6b6f76' }}>
            {d.situacao_op_rotulo || d.situacao_op || 'Sem situação'}
          </span>
          {d.origem_op === 'wik' && (
            <span className="op-cal-chip" style={{ background: d.sincroniza_wik ? '#6a1b9a' : '#455a64' }}>
              {d.sincroniza_wik ? 'Wik · sincroniza' : 'Wik · editada à mão'}
            </span>
          )}
          {d.atrasada_wik && d.situacao_op !== 'concluida' && d.situacao_op !== 'cancelada' && (
            <span className="op-cal-chip" style={{ background: '#c62828' }}>Atrasada no Wik</span>
          )}
        </div>
        <Link className="btn-sec" to={`/producao?ordem=${ordemId}`}>Abrir a OP</Link>
      </div>

      <p className="op-cal-aviso">
        <Lock size={12} /> Prazo, situação e grade seguem a OP sozinhos — para mudar, edite a OP.
      </p>

      <div className="op-cal-grade-dados">
        <Dado rotulo="Produto">
          <span className="mono">{d.referencia_texto}</span>{d.produto_descricao ? ` — ${d.produto_descricao}` : ''}
        </Dado>
        <Dado rotulo="Marca">{d.marca}</Dado>
        <Dado rotulo={d.tipo_op === 'kit' ? 'Kit' : 'Descrição da OP'}>{d.nome_op || (d.tipo_op === 'kit' ? 'Kit' : null)}</Dado>
        <Dado rotulo="Facção">{d.fornecedor_nome}</Dado>
        <Dado rotulo="Situação no Wik">{d.wik_situacao}</Dado>
        <Dado rotulo="Abertura">{d.data_abertura ? dataBr(d.data_abertura) : null}</Dado>
        <Dado rotulo="Início previsto">{d.data_inicio_op ? dataBr(d.data_inicio_op) : null}</Dado>
        <Dado rotulo="Prazo de entrega">{d.data_prevista_op ? dataBr(d.data_prevista_op) : null}</Dado>
        <Dado rotulo="Concluída em">{d.data_conclusao_op ? dataBr(d.data_conclusao_op) : null}</Dado>
      </div>

      <div className="op-cal-numeros">
        <div><strong>{n(d.quantidade)}</strong><span>planejadas</span></div>
        <div><strong>{n(d.quantidade_produzida)}</strong><span>produzidas</span></div>
        <div><strong>{n(d.quantidade_segunda)}</strong><span>2ª qualidade</span></div>
        {d.quantidade_kits != null && <div><strong>{n(d.quantidade_kits)}</strong><span>kits</span></div>}
      </div>

      {d.etapas && (
        <Dado rotulo="Onde as peças estão"><span className="op-cal-etapas">{d.etapas}</span></Dado>
      )}

      {porCor.length > 0 && tamanhos.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="op-cal-tabela">
            <thead>
              <tr>
                <th>Cor</th>
                {tamanhos.map((t) => <th key={t} className="num">{t}</th>)}
                <th className="num">Total</th>
                <th className="num">Prod.</th>
              </tr>
            </thead>
            <tbody>
              {porCor.map((c) => (
                <tr key={c.cor}>
                  <td>{c.cor}</td>
                  {tamanhos.map((t) => {
                    const q = celula(c.cor, t);
                    return <td key={t} className="num">{q ? n(q) : '·'}</td>;
                  })}
                  <td className="num"><strong>{n(c.planejada)}</strong></td>
                  <td className="num">{n(c.produzida)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {porCor.length === 0 && (
        <p className="op-cal-aviso">A grade (cores e tamanhos) ainda não chegou desta OP — entra sozinha na próxima leitura.</p>
      )}

      {d.observacoes_op && <Dado rotulo="Observação da OP">{d.observacoes_op}</Dado>}
      {d.sincronizado_em && (
        <p className="op-cal-aviso" style={{ marginBottom: 0 }}>
          <RefreshCw size={12} /> Conferido com a OP em {new Date(d.sincronizado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      )}
    </div>
  );
}
