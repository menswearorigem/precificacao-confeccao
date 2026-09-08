import { useCallback, useEffect, useState } from 'react';
import {
  Tags, RefreshCw, AlertTriangle, Info, TrendingDown, Check,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, Select, Field, Checkbox, IndicadorDestaque,
} from '../components/ui';
import { SeloPlataforma } from '../lib/canalMarketplace';
import { brl, pct } from '../lib/format';

// Análises › Preço por canal.
//
// Junta as duas metades que sempre existiram separadas: o motor, que sabe
// formar preço, e as tabelas de comissão de cada marketplace. Até aqui o
// preço sugerido era um só para todos os canais — ou seja, não entregava a
// margem pedida em nenhum.
//
// A tela responde duas perguntas. A primeira é a esperada ("por quanto tenho
// que vender em cada canal?"). A segunda é a que muda decisão: o preço que
// você pratica HOJE, que margem dá em cada canal?
//
// ⚠️ Esta tela NÃO grava preço. Ela lê o custo e o imposto do motor e mostra
// a conta; quem decide mudar preço é uma pessoa, na Ficha (REGRA 1).

const TOM_MARGEM = (m, minima) => {
  if (m == null) return '';
  if (m < 0) return 'ink-prejuizo';
  if (minima != null && m < minima) return 'ink-atencao';
  return '';
};

function Canal({ c, margemMinima }) {
  const praticado = c.margemDoPrecoPraticado;
  return (
    <div className="card">
      <div className="pagina-topo">
        <h2 className="card-titulo">
          <SeloPlataforma chave={c.marketplace} size={18} />
          {c.nome}
          {c.tipoAnuncio && <span className="selo tone-neutro">{c.tipoAnuncio}</span>}
        </h2>
      </div>

      {(c.ressalvas || []).map((t) => (
        <p key={t} className="aviso-inline"><AlertTriangle size={14} /> {t}</p>
      ))}

      {praticado && (
        praticado.margem == null ? (
          <p className="aviso-inline"><AlertTriangle size={14} /> {praticado.motivo}</p>
        ) : (
          <div className={praticado.margem < (margemMinima ?? 0) ? 'bloco-alerta' : 'sucesso-inline'}>
            <p>
              {praticado.margem < (margemMinima ?? 0) ? <TrendingDown size={14} /> : <Check size={14} />}
              O preço que você pratica hoje ({brl(praticado.preco)}) entrega{' '}
              <strong>{pct(praticado.margem, 1)}</strong> de margem neste canal
              {' '}— comissão de {pct(praticado.comissaoPct, 1)}
              {praticado.taxaFixa > 0 ? ` mais ${brl(praticado.taxaFixa)} fixos por peça` : ''}.
            </p>
          </div>
        )
      )}

      <div className="tabela-rolagem">
        <table className="tabela-nota">
          <thead>
            <tr>
              <th>Para ter</th><th className="num">Vender por</th>
              <th className="num">Comissão da faixa</th><th className="num">Fixo por peça</th>
              <th className="num">Margem que sobra</th><th>Observação</th>
            </tr>
          </thead>
          <tbody>
            {c.precos.map((p) => {
              const r = p.resultado;
              return (
                <tr key={p.chave} className={r.degrau ? 'linha-pendente' : undefined}>
                  <td><strong>{p.rotulo}</strong> <span className="ink-faint">({pct(p.valor, 0)})</span></td>
                  <td className="num">{r.ok ? <strong>{brl(r.preco)}</strong> : '—'}</td>
                  <td className="num">{r.ok ? pct(r.faixa.pct, 1) : '—'}</td>
                  <td className="num">{r.ok ? brl(r.faixa.fixo) : '—'}</td>
                  <td className={`num ${TOM_MARGEM(r.margemReal, margemMinima)}`}>
                    {r.ok && r.margemReal != null ? pct(r.margemReal, 1) : '—'}
                  </td>
                  <td className="ink-soft">
                    {!r.ok && r.motivo}
                    {r.degrau && r.degrau.texto}
                    {r.aviso && r.aviso}
                    {r.ok && !r.degrau && !r.aviso && r.unico && 'Preço consistente com a própria faixa da tabela.'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {c.precos.some((p) => p.resultado.impossiveis?.length > 0) && (
        <details>
          <summary className="ink-soft ajuda-bloco">Faixas em que essa margem não cabe no preço</summary>
          <ul className="ink-soft ajuda-bloco">
            {c.precos.flatMap((p) => (p.resultado.impossiveis || []).map((i, n) => (
              <li key={`${p.chave}-${n}`}>{p.rotulo}: {i.motivo}</li>
            )))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function PrecoPorCanalPage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [pix, setPix] = useState(false);
  const [frete, setFrete] = useState(true);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.get('/produtos')
      .then((r) => setProdutos(Array.isArray(r) ? r : (r?.itens || [])))
      .catch(() => setProdutos([]));
  }, []);

  const carregar = useCallback(async () => {
    if (!produtoId) { setDados(null); return; }
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (pix) qs.set('forma_pagamento', 'pix');
      if (!frete) qs.set('frete', 'false');
      setDados(await api.get(`/preco-por-canal/${produtoId}?${qs}`));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [produtoId, pix, frete]);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Tags size={22} /> Preço por canal</h1>
          <p className="ink-soft">
            O mesmo custo, a taxa de cada marketplace, e o preço que de fato entrega a margem.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando || !produtoId}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <div className="card">
        <div className="form-linha">
          <Field label="Referência">
            <Select
              value={produtoId}
              onChange={(e) => setProdutoId(e.target.value)}
              placeholder="Escolha a referência"
              chaveRecentes="preco-canal-produto"
            >
              {produtos.map((p) => (
                <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>
              ))}
            </Select>
          </Field>
          <Field label="Pagamento">
            <label className="check-linha">
              <Checkbox checked={pix} onChange={(e) => setPix(e.target.checked)} />
              Considerar Pix (onde o canal subsidia parte da comissão)
            </label>
          </Field>
          <Field label="Frete">
            <label className="check-linha">
              <Checkbox checked={frete} onChange={(e) => setFrete(e.target.checked)} />
              Incluir o frete subsidiado no custo
            </label>
          </Field>
        </div>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={280} />}

      {!carregando && !produtoId && (
        <EstadoVazio
          Icone={Tags}
          titulo="Escolha uma referência"
          descricao="A comparação é por peça: o custo vem da ficha dela e a taxa vem da tabela de cada canal."
        />
      )}

      {!carregando && dados && !dados.ok && (
        <EstadoVazio Icone={AlertTriangle} titulo="Não dá para formar preço" descricao={dados.motivo} />
      )}

      {!carregando && dados?.ok && (
        <>
          <p className="ink-soft ajuda-bloco"><Info size={14} /> {dados.explicacao}</p>

          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Custo de produção"
              valor={brl(dados.custo.subtotalProducao)}
              explicacao={`Material ${brl(dados.custo.totalMateriais)} + industrial ${brl(dados.custo.totalIndustrial)} + indireto ${brl(dados.custo.custoIndireto)}. Vem do motor, o mesmo número da Ficha.`}
            />
            <IndicadorDestaque rotulo="Imposto da empresa" valor={pct(dados.custo.pctImpostos, 2)} />
            <IndicadorDestaque
              rotulo="Preço praticado"
              valor={dados.produto.precoPraticado ? brl(dados.produto.precoPraticado) : 'não informado'}
            />
            <IndicadorDestaque
              rotulo="Peso cadastrado"
              valor={dados.produto.pesoKg ? `${dados.produto.pesoKg} kg` : 'sem peso'}
              tom={dados.produto.pesoKg ? undefined : 'atencao'}
              explicacao="Sem peso não dá para achar a faixa de frete, e o frete subsidiado fica de fora do preço — que então sai otimista."
            />
          </div>

          {dados.canais.map((c) => (
            <Canal key={`${c.marketplace}-${c.tipoAnuncio || 'unico'}`} c={c} margemMinima={dados.margemMinima} />
          ))}
        </>
      )}
    </div>
  );
}
