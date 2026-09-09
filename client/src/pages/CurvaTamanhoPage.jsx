import { useCallback, useEffect, useState } from 'react';
import {
  Ruler, RefreshCw, AlertTriangle, Info, Scissors, Layers,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, Select, Field, NumInput, IndicadorDestaque,
} from '../components/ui';
import { pct, formatQtd, numeroBr } from '../lib/format';

// Estoque › Curva de tamanho.
//
// Responde "de cada 300 peças, quantas de cada tamanho?" com o histórico em
// vez do chute. Duas coisas ficam à vista de propósito:
//
//   1. DE ONDE VEIO A CURVA. Referência, categoria ou geral. Uma referência
//      nova não tem histórico, e usar o dela com 12 peças vendidas seria
//      ruído disfarçado de dado. A tela diz qual nível foi usado e por quê os
//      outros foram descartados.
//
//   2. O TAMANHO QUE ESGOTOU. Ele vendeu menos porque acabou, não porque não
//      havia procura. Cortar pela curva como está corta menos ainda dele, ele
//      esgota mais cedo, e a curva "aprende" a coisa errada. A tela avisa, e
//      a correção é decisão de gente.

const NIVEL_ROTULO = {
  referencia: 'desta referência',
  categoria: 'da categoria',
  geral: 'de todas as referências',
};

function Barra({ valor, esgotou }) {
  return (
    <div className="curva-barra-trilho" title={pct(valor, 1)}>
      <div
        className={`curva-barra-preenchida ${esgotou ? 'curva-barra-censurada' : ''}`}
        style={{ width: `${Math.max(2, valor * 100)}%` }}
      />
    </div>
  );
}

export default function CurvaTamanhoPage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [meses, setMeses] = useState(12);
  const [lote, setLote] = useState(300);
  const [minimo, setMinimo] = useState(0);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    // `/estoque/produtos-referencia` e NÃO `/produtos` (09/09/2026):
    // `/produtos` exige o módulo `produto` ou `analises`, e o público desta
    // tela é o módulo ESTOQUE. Quem só tinha estoque levava 403, o
    // `.catch` engolia, e o seletor "Referência" ficava permanentemente
    // vazio — sem mensagem, sem pista. A rota usada agora existe
    // exatamente para isso, e ainda evita trafegar custo e margem para
    // dentro do Estoque.
    api.get('/estoque/produtos-referencia')
      .then((r) => setProdutos(Array.isArray(r) ? r : (r?.itens || [])))
      .catch((e) => setErro(e.message));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams({ meses: String(meses) });
      if (produtoId) qs.set('produto_id', String(produtoId));
      if (lote > 0) qs.set('lote', String(lote));
      if (minimo > 0) qs.set('minimo', String(minimo));
      setDados(await api.get(`/analises-estoque/curva-tamanho?${qs}`));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [produtoId, meses, lote, minimo]);

  useEffect(() => { carregar(); }, [carregar]);

  const c = dados?.curva;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Ruler size={22} /> Curva de tamanho</h1>
          <p className="ink-soft">
            Quanto cortar de cada tamanho, pela venda que já aconteceu.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <div className="card">
        <div className="form-linha">
          <Field label="Referência" hint="Em branco = curva geral da casa">
            <Select
              value={produtoId}
              onChange={(e) => setProdutoId(e.target.value)}
              placeholder="Todas as referências"
              chaveRecentes="curva-tamanho-produto"
            >
              {produtos.map((p) => (
                <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>
              ))}
            </Select>
          </Field>
          <Field label="Histórico (meses)">
            <NumInput value={meses} step="1" onChange={(v) => setMeses(v || 12)} />
          </Field>
          <Field label="Lote a cortar (peças)">
            <NumInput value={lote} step="1" onChange={(v) => setLote(v || 0)} />
          </Field>
          <Field label="Mínimo por tamanho" hint="Abaixo disso o tamanho sai da grade">
            <NumInput value={minimo} step="1" onChange={(v) => setMinimo(v || 0)} />
          </Field>
        </div>
      </div>

      {dados?.explicacao && (
        <p className="ink-soft ajuda-bloco"><Info size={14} /> {dados.explicacao}</p>
      )}
      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={260} />}

      {!carregando && dados && !dados.ok && (
        <EstadoVazio
          Icone={Ruler}
          titulo="Sem histórico para montar a curva"
          descricao={dados.motivo}
        />
      )}

      {!carregando && c && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Curva usada"
              valor={NIVEL_ROTULO[c.nivel] || c.nivel}
              Icone={Layers}
              explicacao="Quando a referência tem histórico curto demais, a curva sobe para a categoria e depois para o geral — porque uma participação medida sobre poucas peças muda com uma venda a mais."
            />
            <IndicadorDestaque rotulo="Peças no histórico" valor={formatQtd(c.total)} />
            <IndicadorDestaque
              rotulo="Volume"
              valor={c.volumeSuficiente ? 'Suficiente' : 'Curto'}
              tom={c.volumeSuficiente ? undefined : 'atencao'}
              explicacao={`Abaixo de ${c.pecasMinimas} peças a participação de cada tamanho é instável.`}
            />
            <IndicadorDestaque
              rotulo="Tamanhos que esgotaram"
              valor={c.censura.length > 0 ? c.censura.join(', ') : 'nenhum'}
              tom={c.censura.length > 0 ? 'atencao' : undefined}
              explicacao="Esgotou = vendeu menos do que teria vendido. A participação deles está subestimada."
            />
          </div>

          {(c.ressalvas || []).map((t) => (
            <p key={t} className="aviso-inline"><AlertTriangle size={14} /> {t}</p>
          ))}

          {dados.descartadas?.length > 0 && (
            <p className="ink-soft ajuda-bloco">
              <Info size={13} /> Níveis descartados:{' '}
              {dados.descartadas.map((d) => `${NIVEL_ROTULO[d.nivel] || d.nivel} (${d.motivo})`).join('; ')}.
            </p>
          )}

          <div className="card">
            <h2 className="card-titulo"><Ruler size={16} /> Participação de cada tamanho</h2>
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th>Tamanho</th><th className="num">Vendidas</th>
                    <th className="num">Participação</th><th style={{ width: '40%' }}>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {c.itens.map((i) => (
                    <tr key={i.tamanho}>
                      <td><strong>{i.tamanho}</strong>{i.esgotouNaJanela && <span className="selo tone-atencao">esgotou</span>}</td>
                      <td className="num">{formatQtd(i.unidades)}</td>
                      <td className="num">{pct(i.participacao, 1)}</td>
                      <td><Barra valor={i.participacao} esgotou={i.esgotouNaJanela} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {dados.grade?.ok && (
            <div className="card">
              <h2 className="card-titulo"><Scissors size={16} /> Grade para cortar {formatQtd(dados.grade.lote)} peças</h2>
              <p className="ink-soft ajuda-bloco">
                Distribuída pelo método do maior resto: as sobras do arredondamento vão uma a
                uma para quem mais perdeu na conta, e a soma fecha exatamente no lote. Arredondar
                cada tamanho por conta própria daria 299 ou 301 peças.
              </p>
              {!dados.grade.somaConfere && (
                <p className="erro-inline">
                  A grade somou {formatQtd(dados.grade.soma)} peças e o lote é {formatQtd(dados.grade.lote)}.
                  Isto é defeito — não corte por esta grade.
                </p>
              )}
              {(dados.grade.ajustes || []).map((a) => (
                <p key={a} className="aviso-inline"><AlertTriangle size={14} /> {a}</p>
              ))}
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Tamanho</th><th className="num">Cortar</th>
                      <th className="num">Participação</th><th className="num">Conta exata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.grade.linhas.map((l) => (
                      <tr key={l.tamanho} className={l.removidoPeloMinimo ? 'linha-pendente' : undefined}>
                        <td><strong>{l.tamanho}</strong></td>
                        <td className="num"><strong>{formatQtd(l.quantidade)}</strong></td>
                        <td className="num">{pct(l.participacao, 1)}</td>
                        {/* numeroBr: `toFixed` imprimia "12.50" com ponto,
                            num sistema inteiro em português. */}
                        <td className="num ink-faint">{numeroBr(l.exato, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>Total</th>
                      <th className="num">{formatQtd(dados.grade.soma)}</th>
                      <th colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
