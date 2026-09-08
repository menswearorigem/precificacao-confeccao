import { useCallback, useEffect, useState } from 'react';
import {
  Banknote, RefreshCw, AlertTriangle, Info, PackageX, Clock, Tag,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field,
} from '../components/ui';
import { brl, pct, formatQtd } from '../lib/format';

// Estoque › Dinheiro parado.
//
// Responde em REAIS uma pergunta que o sistema até hoje só respondia em
// peças: quanto do dinheiro da empresa está preso em roupa que não vende, e
// há quanto tempo.
//
// Três coisas que esta tela faz questão de deixar à vista, porque são elas
// que separam o número honesto do número bonito:
//
//   · o valor é ao CUSTO, não ao preço de venda. Preço de venda só existiria
//     se a peça vendesse — e ela não está vendendo;
//   · peça sem ficha de custo NÃO entra como R$ 0,00. Ela é contada em peças,
//     à parte, e o total em R$ é declarado como PISO enquanto isso durar;
//   · peça que entrou esta semana e ainda não vendeu não é estoque morto. A
//     idade conta da última venda; sem venda nenhuma, da entrada no estoque.

const TOM_FAIXA = {
  saudavel: 'tone-saudavel',
  atencao: 'tone-atencao',
  prejuizo: 'tone-prejuizo',
};

const JANELAS = [
  { valor: 91, rotulo: 'Parado há mais de 90 dias (uma estação)' },
  { valor: 181, rotulo: 'Parado há mais de 180 dias (duas estações)' },
  { valor: 366, rotulo: 'Parado há mais de 1 ano' },
];

export default function EstoqueParadoPage() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [dias, setDias] = useState(91);
  const [verDetalhe, setVerDetalhe] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await api.get(`/analises-estoque/parado?dias=${dias}`));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [dias]);

  useEffect(() => { carregar(); }, [carregar]);

  const r = dados?.resumo;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Banknote size={22} /> Dinheiro parado no estoque</h1>
          <p className="ink-soft">
            Quanto do caixa está preso em peça que não vende, e há quanto tempo.
          </p>
        </div>
        <div className="pagina-acoes">
          <Field label="Considerar parado a partir de">
            <Select value={String(dias)} onChange={(e) => setDias(Number(e.target.value))}>
              {JANELAS.map((j) => <option key={j.valor} value={j.valor}>{j.rotulo}</option>)}
            </Select>
          </Field>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {dados?.explicacao && (
        <p className="ink-soft ajuda-bloco"><Info size={14} /> {dados.explicacao}</p>
      )}
      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={300} />}

      {!carregando && r && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo={r.totalEhPiso ? 'Parado em R$ (no mínimo)' : 'Parado em R$'}
              valor={brl(r.valorParado)}
              tom={r.valorParado > 0 ? 'atencao' : undefined}
              Icone={Banknote}
              explicacao="Ao custo de produção: material + custo industrial + custo indireto. Sem imposto e sem taxa de marketplace, porque esses só existem quando a peça vende."
            />
            <IndicadorDestaque rotulo="Peças paradas" valor={formatQtd(r.pecas)} />
            <IndicadorDestaque rotulo="Referências envolvidas" valor={formatQtd(r.referencias)} />
            <IndicadorDestaque
              rotulo="Parado há mais de 1 ano"
              valor={brl(r.valorAcimaDeUmAno)}
              tom={r.valorAcimaDeUmAno > 0 ? 'prejuizo' : undefined}
              explicacao="Atravessou a mesma estação duas vezes sem vender. Aqui o dinheiro só volta com liquidação, kit ou desmanche."
            />
          </div>

          {r.totalEhPiso && (
            <p className="aviso-inline">
              <AlertTriangle size={14} />
              O valor acima é um PISO, não o número final: {formatQtd(r.pecasSemCusto)} peça(s)
              de {r.variantesSemCusto} variante(s) estão paradas em referências sem custo
              calculado, e por isso não entram no total em R$. Elas aparecem na lista abaixo.
            </p>
          )}

          {(dados.ressalvas || []).map((t) => (
            <p key={t} className="ink-soft ajuda-bloco"><Info size={13} /> {t}</p>
          ))}

          {r.pecas === 0 && r.pecasSemCusto === 0 && (
            <EstadoVazio
              Icone={PackageX}
              titulo="Nada parado nesta janela"
              descricao="Nenhuma variante com saldo está sem vender há tempo suficiente para entrar nesta análise."
            />
          )}

          {dados.porFaixa.length > 0 && (
            <div className="card">
              <h2 className="card-titulo"><Clock size={16} /> Por tempo parado</h2>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Faixa</th><th className="num">Variantes</th><th className="num">Peças</th>
                      <th className="num">Valor ao custo</th><th>O que significa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.porFaixa.map((f) => (
                      <tr key={f.chave}>
                        <td><span className={`selo ${TOM_FAIXA[f.tom]}`}>{f.rotulo}</span></td>
                        <td className="num">{formatQtd(f.variantes)}</td>
                        <td className="num">
                          {formatQtd(f.pecas)}
                          {f.pecasSemCusto > 0 && (
                            <span className="ink-faint" title="Peças em referências sem custo calculado — não entram no valor">
                              {' '}+{formatQtd(f.pecasSemCusto)} s/ custo
                            </span>
                          )}
                        </td>
                        <td className="num">{brl(f.valorParado)}</td>
                        <td className="ink-soft">{f.leitura}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dados.recuperacao?.length > 0 && r.valorParado > 0 && (
            <div className="card">
              <h2 className="card-titulo"><Tag size={16} /> Quanto volta ao caixa numa liquidação</h2>
              <p className="ink-soft ajuda-bloco">
                Não é uma recomendação de desconto: é a conta que se faz de qualquer jeito antes
                de decidir. A perda já aconteceu quando a peça parou — o desconto só a torna
                visível.
              </p>
              <div className="indicadores-linha">
                {dados.recuperacao.map((x) => (
                  <IndicadorDestaque
                    key={x.percentualDoCusto}
                    rotulo={x.percentualDoCusto === 1 ? 'Vendendo pelo custo' : `Vendendo a ${pct(x.percentualDoCusto, 0)} do custo`}
                    valor={brl(x.entra)}
                    explicacao={x.perda > 0 ? `Perda de ${brl(x.perda)} em relação ao que foi gasto para produzir.` : 'Recupera exatamente o que foi gasto para produzir, sem lucro.'}
                    tom={x.perda > 0 ? 'atencao' : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {dados.referencias.length > 0 && (
            <div className="card">
              <div className="pagina-topo">
                <h2 className="card-titulo"><PackageX size={16} /> Referências que prendem mais dinheiro</h2>
                <button type="button" className="btn-sec" onClick={() => setVerDetalhe((v) => !v)}>
                  {verDetalhe ? 'Ver por referência' : 'Ver variante por variante'}
                </button>
              </div>
              <div className="tabela-rolagem">
                {!verDetalhe ? (
                  <table className="tabela-nota">
                    <thead>
                      <tr>
                        <th>Referência</th><th>Descrição</th><th className="num">Variantes</th>
                        <th className="num">Peças</th><th className="num">Valor ao custo</th>
                        <th className="num">Parada há</th><th>Tamanhos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.referencias.map((x) => (
                        <tr key={x.produtoId ?? x.referencia}>
                          <td className="mono">{x.referencia}</td>
                          <td>{x.descricao}</td>
                          <td className="num">{formatQtd(x.variantes)}</td>
                          <td className="num">{formatQtd(x.pecas)}</td>
                          <td className="num">{brl(x.valorParado)}</td>
                          <td className={`num ${x.idadeMaxima > 365 ? 'ink-prejuizo' : ''}`}>{formatQtd(x.idadeMaxima)} dias</td>
                          <td className="ink-soft">{x.tamanhos.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="tabela-nota">
                    <thead>
                      <tr>
                        <th>Referência</th><th>Cor</th><th>Tamanho</th>
                        <th className="num">Peças</th><th className="num">Custo unit.</th>
                        <th className="num">Valor parado</th><th className="num">Parada há</th><th>Desde</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.itens.map((i) => (
                        <tr key={i.varianteId} className={i.idadeDias > 365 ? 'linha-prejuizo' : undefined}>
                          <td className="mono">{i.referencia}</td>
                          <td>{i.cor}</td>
                          <td>{i.tamanho}</td>
                          <td className="num">{formatQtd(i.saldo)}</td>
                          <td className="num">{brl(i.custoUnitario)}</td>
                          <td className="num">{brl(i.valorParado)}</td>
                          <td className="num">{formatQtd(i.idadeDias)} dias</td>
                          <td className="ink-soft">
                            {i.nuncaVendeu ? 'nunca vendeu — conta da entrada no estoque' : 'última venda'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {dados.semCusto.length > 0 && (
            <div className="card">
              <h2 className="card-titulo"><AlertTriangle size={16} /> Paradas, mas sem custo para valorizar</h2>
              <p className="ink-soft ajuda-bloco">
                Estas peças estão paradas do mesmo jeito — o que falta é a ficha de custo da
                referência. Enquanto ela não existir, elas não podem entrar no total em R$ sem
                que o total vire um número inventado.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th className="num">Peças</th><th className="num">Parada há</th></tr>
                  </thead>
                  <tbody>
                    {dados.semCusto.map((i) => (
                      <tr key={i.varianteId}>
                        <td className="mono">{i.referencia}</td>
                        <td>{i.cor}</td>
                        <td>{i.tamanho}</td>
                        <td className="num">{formatQtd(i.saldo)}</td>
                        <td className="num">{formatQtd(i.idadeDias)} dias</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dados.semIdade.length > 0 && (
            <div className="card">
              <h2 className="card-titulo"><Info size={16} /> Sem como medir há quanto tempo estão paradas</h2>
              <p className="ink-soft ajuda-bloco">
                Nunca venderam e não têm nenhum movimento de entrada registrado. Podem estar
                paradas há anos ou ter entrado ontem — e chutar qualquer uma das duas coisas
                mudaria o total.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th className="num">Peças</th></tr></thead>
                  <tbody>
                    {dados.semIdade.map((i) => (
                      <tr key={i.varianteId}>
                        <td className="mono">{i.referencia}</td>
                        <td>{i.cor}</td>
                        <td>{i.tamanho}</td>
                        <td className="num">{formatQtd(i.saldo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
