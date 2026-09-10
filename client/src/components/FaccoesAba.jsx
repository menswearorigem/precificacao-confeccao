import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, Plus, RefreshCw, Tag, X, Check, AlertTriangle, Trash2,
  DollarSign, Phone, MapPin, Info, Download,
} from 'lucide-react';
import { api } from '../api/client';
import {
  Field, Select, NumInput, CampoBusca, EstadoVazio, Skeleton, IndicadorDestaque, DateInput,
} from './ui';
import { confirmar } from './ConfirmDialog';
import NovaFaccaoModal from './NovaFaccaoModal';
import { brl, pct, formatQtd, dataBr, numeroBr } from '../lib/format';

// Produção › Facções.
//
// Duas coisas numa aba só, porque são a mesma decisão:
//
//   1. O CADASTRO — quem é a facção, com tudo que um fornecedor tem (o dono
//      pediu "tão completo quanto o preenchimento de fornecedores") mais a
//      categoria, que é o que permite perguntar "quanto gastei com lavanderia
//      este mês".
//
//   2. A TABELA DE PREÇO por etapa. Ela existe no banco desde a 0054 e NUNCA
//      teve tela: o sistema dizia "cadastre o preço da facção" em três lugares
//      e não havia onde fazer isso a não ser por SQL. Toda O.S. da casa nascia
//      sem preço, e o custo do serviço aparecia como "—" para sempre.
//
// A lista já traz o que decide qual facção usar: quanto está fora, quanto
// quebrou, quantas O.S. estão atrasadas e quanto custa a peça. Sem isso,
// escolher facção continua sendo pelo telefone.

function Categorias({ categorias, etapas, onMudou, onFechar }) {
  const [nova, setNova] = useState({ nome: '', etapa_id: '' });
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  async function acao(fn) {
    setErro(''); setAviso('');
    try { const r = await fn(); if (r?.aviso) setAviso(r.aviso); await onMudou(); }
    catch (e) { setErro(e.message); }
  }

  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
      <div className="anuncio-painel">
        <header className="anuncio-painel-topo">
          <h2><Tag size={18} /> Categorias de facção</h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>
        <div className="anuncio-painel-corpo">
          <p className="ink-soft ajuda-bloco">
            Costureira, lavanderia, bordado, estamparia. É cadastro e não texto livre pelo mesmo
            motivo dos motivos de reprocesso: texto livre não agrupa, e "quanto gastei com
            lavanderia" só tem resposta se lavanderia for uma coisa e não três grafias.
          </p>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Categoria</th><th>Etapa do fluxo</th><th className="num">Facções</th><th /></tr>
              </thead>
              <tbody>
                {categorias.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input
                        className="input" defaultValue={c.nome}
                        onBlur={(e) => e.target.value !== c.nome
                          && acao(() => api.put(`/faccoes/categorias/${c.id}`, { nome: e.target.value }))}
                      />
                    </td>
                    <td>
                      <Select
                        value={c.etapa_id || ''}
                        placeholder="Nenhuma"
                        onChange={(e) => acao(() => api.put(`/faccoes/categorias/${c.id}`, {
                          etapa_id: e.target.value ? Number(e.target.value) : null,
                        }))}
                      >
                        {etapas.map((et) => <option key={et.id} value={et.id}>{et.nome}</option>)}
                      </Select>
                    </td>
                    <td className="num">{formatQtd(c.faccoes)}</td>
                    <td>
                      <button
                        type="button" className="btn-icone perigo" aria-label={`Excluir ${c.nome}`}
                        onClick={async () => {
                          if (!(await confirmar(`Excluir a categoria ${c.nome}?`, {
                            titulo: 'Excluir categoria', confirmarTexto: 'Excluir', perigo: true,
                          }))) return;
                          acao(() => api.del(`/faccoes/categorias/${c.id}`));
                        }}
                      ><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
                <tr className="linha-nova">
                  <td>
                    <input
                      className="input" placeholder="Serigrafia" value={nova.nome}
                      onChange={(e) => setNova((n) => ({ ...n, nome: e.target.value }))}
                    />
                  </td>
                  <td>
                    <Select
                      value={nova.etapa_id} placeholder="Nenhuma"
                      onChange={(e) => setNova((n) => ({ ...n, etapa_id: e.target.value }))}
                    >
                      {etapas.map((et) => <option key={et.id} value={et.id}>{et.nome}</option>)}
                    </Select>
                  </td>
                  <td colSpan={2}>
                    <button
                      type="button" className="btn-sec" disabled={!nova.nome.trim()}
                      onClick={() => acao(async () => {
                        const r = await api.post('/faccoes/categorias', {
                          nome: nova.nome, etapa_id: nova.etapa_id ? Number(nova.etapa_id) : null,
                        });
                        setNova({ nome: '', etapa_id: '' });
                        return r;
                      })}
                    ><Plus size={14} /> Criar</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {erro && <p className="erro-inline">{erro}</p>}
          {aviso && <p className="aviso-inline"><Info size={14} /> {aviso}</p>}
        </div>
        <footer className="painel-rodape">
          <button type="button" className="btn" onClick={onFechar}>Fechar</button>
        </footer>
      </div>
    </div>
  );
}

function FichaFaccao({ faccaoId, etapas, produtos, onFechar, onEditar, onMudou }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [novoPreco, setNovoPreco] = useState({ etapa_id: '', produto_id: '', valor_por_peca: '', vigencia_inicio: '' });

  const carregar = useCallback(async () => {
    try { setDados(await api.get(`/faccoes/${faccaoId}`)); }
    catch (e) { setErro(e.message); }
  }, [faccaoId]);
  useEffect(() => { carregar(); }, [carregar]);

  if (!dados) {
    return (
      <div className="anuncio-painel-fundo painel-fundo-clicavel">
        <div className="anuncio-painel painel-largo"><Skeleton height={280} /></div>
      </div>
    );
  }

  const f = dados.faccao;
  const emCurso = dados.ordensServico.filter((o) => ['remetida', 'parcial'].includes(o.situacao));
  const fora = emCurso.reduce(
    (s, o) => s + (Number(o.remetido) - Number(o.retornado_bom) - Number(o.retornado_segunda) - Number(o.perda_declarada)), 0
  );
  const remetido = dados.ordensServico.reduce((s, o) => s + Number(o.remetido || 0), 0);
  const quebra = dados.ordensServico.reduce((s, o) => s + Number(o.quebra || 0), 0);
  const hoje = new Date().toISOString().slice(0, 10);
  const precosVigentes = dados.precos.filter((p) => !p.vigencia_fim || p.vigencia_fim >= hoje);

  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
      <div className="anuncio-painel painel-largo">
        <header className="anuncio-painel-topo">
          <h2>
            <Building2 size={18} /> {f.nome}
            {f.categoria_nome && <span className="selo tone-neutro">{f.categoria_nome}</span>}
            {!f.ativo && <span className="selo tone-prejuizo">inativa</span>}
          </h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>

        <div className="anuncio-painel-corpo">
          <div className="indicadores-linha">
            <IndicadorDestaque rotulo="O.S. em curso" valor={formatQtd(emCurso.length)} />
            <IndicadorDestaque
              rotulo="Peças fora daqui" valor={formatQtd(fora)}
              tom={fora > 0 ? 'atencao' : undefined}
              explicacao="Remetidas e ainda não devolvidas. Continuam sendo estoque da empresa."
            />
            <IndicadorDestaque
              rotulo="Quebra acumulada" valor={formatQtd(quebra)}
              tom={quebra > 0 ? 'prejuizo' : undefined}
              variacao={remetido > 0 ? pct(quebra / remetido, 1) : undefined}
              explicacao="Remetido menos o que voltou (bom + segunda + perda declarada). É medida, nunca digitada."
            />
            <IndicadorDestaque
              rotulo="Capacidade / mês"
              valor={f.faccao_capacidade_mes != null ? `${formatQtd(f.faccao_capacidade_mes)} peças` : 'não declarada'}
              tom={f.faccao_capacidade_mes == null ? 'atencao' : undefined}
              explicacao="Sem capacidade declarada não dá para dizer se a facção cabe mais uma ordem."
            />
          </div>

          <div className="form-linha">
            <div className="ficha-bloco">
              <span className="field-label">Documento</span>
              <p>{f.cpf_cnpj || '—'}{f.razao_social ? ` · ${f.razao_social}` : ''}</p>
            </div>
            <div className="ficha-bloco">
              <span className="field-label"><Phone size={12} /> Contato</span>
              <p>{[f.contato_nome, f.contato_telefone || f.telefone, f.email].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            <div className="ficha-bloco">
              <span className="field-label"><MapPin size={12} /> Endereço</span>
              <p>{[f.logradouro && `${f.logradouro}, ${f.numero || 's/n'}`, f.bairro, f.cidade, f.uf].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            <div className="ficha-bloco">
              <span className="field-label"><DollarSign size={12} /> Pagamento</span>
              <p>
                {[f.forma_pagamento_padrao, f.condicao_pagamento_padrao].filter(Boolean).join(' · ') || '—'}
                {f.chave_pix ? <><br /><span className="ink-soft">PIX{f.pix_tipo ? ` (${f.pix_tipo})` : ''}: {f.chave_pix}</span></> : null}
              </p>
            </div>
          </div>

          {Object.keys(f.campos_adicionais || {}).length > 0 && (
            <p className="ink-soft ajuda-bloco">
              {Object.entries(f.campos_adicionais).map(([k, v]) => `${k}: ${v}`).join(' · ')}
            </p>
          )}
          {f.observacoes && <p className="ink-soft ajuda-bloco">{f.observacoes}</p>}

          {/* ---------- preço do serviço ---------- */}
          <h3 className="card-titulo"><DollarSign size={16} /> Preço do serviço</h3>
          <p className="ink-soft ajuda-bloco">
            É este preço que a Ordem de Serviço CONGELA na remessa. Reajuste depois não reescreve
            O.S. antiga — por isso o preço tem vigência, e cadastrar um novo encerra o anterior.
          </p>
          {precosVigentes.length === 0 && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> Esta facção não tem preço cadastrado em etapa nenhuma. Toda
              O.S. dela vai nascer sem valor, e o custo do serviço aparece como "—" até alguém
              cadastrar aqui — nunca como R$ 0,00.
            </p>
          )}
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Etapa</th><th>Referência</th><th className="num">R$ / peça</th><th>Vigência</th><th /></tr>
              </thead>
              <tbody>
                {dados.precos.map((p) => {
                  const vigente = !p.vigencia_fim || p.vigencia_fim >= hoje;
                  return (
                    <tr key={p.id} className={vigente ? undefined : 'ink-soft'}>
                      <td>{p.etapa_nome}</td>
                      <td>{p.produto_referencia || <span className="ink-soft">todas</span>}</td>
                      <td className="num">{brl(p.valor_por_peca)}</td>
                      <td>
                        {dataBr(p.vigencia_inicio)}
                        {p.vigencia_fim ? ` até ${dataBr(p.vigencia_fim)}` : ''}
                        {vigente && <span className="selo tone-saudavel">vigente</span>}
                      </td>
                      <td>
                        {vigente && (
                          <button
                            type="button" className="btn-sec btn-mini"
                            onClick={async () => {
                              try { await api.post(`/faccoes/precos/${p.id}/encerrar`, {}); await carregar(); onMudou(); }
                              catch (e) { setErro(e.message); }
                            }}
                          >Encerrar</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="form-linha">
            <Field label="Etapa">
              <Select
                value={novoPreco.etapa_id} placeholder="Escolha a etapa"
                onChange={(e) => setNovoPreco((n) => ({ ...n, etapa_id: e.target.value }))}
              >
                {etapas.map((et) => <option key={et.id} value={et.id}>{et.nome}</option>)}
              </Select>
            </Field>
            <Field label="Só para uma referência" hint="Em branco vale para todas.">
              <Select
                value={novoPreco.produto_id} placeholder="Todas as referências"
                onChange={(e) => setNovoPreco((n) => ({ ...n, produto_id: e.target.value }))}
              >
                {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia}</option>)}
              </Select>
            </Field>
            <Field label="R$ por peça">
              <NumInput value={novoPreco.valor_por_peca} onChange={(v) => setNovoPreco((n) => ({ ...n, valor_por_peca: v }))} />
            </Field>
            <Field label="Vale a partir de">
              <DateInput value={novoPreco.vigencia_inicio} onChange={(e) => setNovoPreco((n) => ({ ...n, vigencia_inicio: e.target.value }))} />
            </Field>
          </div>
          <div className="painel-acoes-inline">
            <button
              type="button" className="btn-sec"
              disabled={!novoPreco.etapa_id || !(Number(novoPreco.valor_por_peca) >= 0) || novoPreco.valor_por_peca === ''}
              onClick={async () => {
                setErro('');
                try {
                  await api.post(`/faccoes/${faccaoId}/precos`, {
                    etapa_id: Number(novoPreco.etapa_id),
                    produto_id: novoPreco.produto_id ? Number(novoPreco.produto_id) : null,
                    valor_por_peca: Number(novoPreco.valor_por_peca),
                    vigencia_inicio: novoPreco.vigencia_inicio || null,
                  });
                  setNovoPreco({ etapa_id: '', produto_id: '', valor_por_peca: '', vigencia_inicio: '' });
                  await carregar();
                  onMudou();
                } catch (e) { setErro(e.message); }
              }}
            ><Plus size={15} /> Cadastrar preço</button>
          </div>

          {/* ---------- material lá ---------- */}
          {dados.material.length > 0 && (
            <>
              <h3 className="card-titulo">Material nosso na mão dela</h3>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead><tr><th>Insumo</th><th className="num">Quantidade</th><th className="num">Valor</th></tr></thead>
                  <tbody>
                    {dados.material.map((m) => (
                      <tr key={m.insumo_id}>
                        <td>{m.insumo_nome}</td>
                        <td className="num">{numeroBr(m.quantidade, 3)} {m.unidade}</td>
                        <td className="num">
                          {m.custo_atual != null
                            ? brl(Number(m.quantidade) * Number(m.custo_atual))
                            : <span className="selo tone-atencao">sem custo</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ---------- histórico de O.S. ---------- */}
          <h3 className="card-titulo">Ordens de serviço</h3>
          {dados.ordensServico.length === 0
            ? <p className="ink-soft">Nenhuma O.S. ainda.</p>
            : (
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th className="num">O.S.</th><th>Etapa</th><th>Referência</th>
                      <th className="num">Remetido</th><th className="num">Voltou bom</th>
                      <th className="num">Quebra</th><th className="num">Serviço</th><th>Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.ordensServico.slice(0, 30).map((o) => (
                      <tr key={o.ordem_servico_id}>
                        <td className="num">{o.numero}</td>
                        <td>{o.etapa_nome}</td>
                        <td>{o.referencia || '—'}</td>
                        <td className="num">{formatQtd(o.remetido)}</td>
                        <td className="num">{formatQtd(o.retornado_bom)}</td>
                        <td className={`num ${Number(o.quebra) > 0 ? 'ink-prejuizo' : ''}`}>{formatQtd(o.quebra)}</td>
                        <td className="num">
                          {o.valor_servico != null ? brl(o.valor_servico) : <span className="selo tone-atencao">sem preço</span>}
                        </td>
                        <td>{o.situacao}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          {erro && <p className="erro-inline">{erro}</p>}
        </div>

        <footer className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Fechar</button>
          <button type="button" className="btn" onClick={() => onEditar(faccaoId)}>Editar cadastro</button>
        </footer>
      </div>
    </div>
  );
}

export default function FaccoesAba({ etapas = [], produtos = [], onMudou }) {
  const [faccoes, setFaccoes] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [importandoWik, setImportandoWik] = useState(false);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');
  const [mostrarInativas, setMostrarInativas] = useState(false);
  const [editando, setEditando] = useState(null);   // id | 'novo'
  const [aberta, setAberta] = useState(null);
  const [gerindoCategorias, setGerindoCategorias] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (buscaAplicada) qs.set('busca', buscaAplicada);
      if (filtroCategoria) qs.set('categoria_id', filtroCategoria);
      if (mostrarInativas) qs.set('ativo', 'todos');
      const [f, c] = await Promise.all([
        api.get(`/faccoes?${qs}`),
        api.get('/faccoes/categorias'),
      ]);
      setFaccoes(f);
      setCategorias(c);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada, filtroCategoria, mostrarInativas]);

  useEffect(() => { carregar(); }, [carregar]);

  const totais = useMemo(() => ({
    ativas: faccoes.filter((f) => f.ativo).length,
    fora: faccoes.reduce((s, f) => s + Number(f.pecas_fora || 0), 0),
    atrasadas: faccoes.reduce((s, f) => s + Number(f.atrasadas || 0), 0),
    semPreco: faccoes.filter((f) => Number(f.precos_cadastrados) === 0).length,
    semCategoria: faccoes.filter((f) => !f.faccao_categoria_id).length,
  }), [faccoes]);

    const importarFaccoesWik = async () => {
    setImportandoWik(true); setErro(''); setAviso('');
    try {
      const r = await api.post('/faccoes/importar-wik', {});
      const partes = [];
      if (r.criadas) partes.push(`${r.criadas} criadas`);
      if (r.vinculadas) partes.push(`${r.vinculadas} vinculadas`);
      if (r.jaExistiam) partes.push(`${r.jaExistiam} já existiam`);
      setAviso(`Facções do Wik: ${partes.join(', ') || 'nada a importar'} (de ${r.totalWik || 0} no Wik).`);
      await carregar();
    } catch (e) {
      setErro(e.message || 'Falha ao importar facções do Wik.');
    } finally {
      setImportandoWik(false);
    }
  };

  return (
    <>
      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Facções ativas" valor={formatQtd(totais.ativas)} Icone={Building2} />
        <IndicadorDestaque
          rotulo="Peças fora daqui" valor={formatQtd(totais.fora)}
          tom={totais.fora > 0 ? 'atencao' : undefined}
          explicacao="Somando todas as facções. Continua sendo estoque da empresa, e não conta no disponível para venda."
        />
        <IndicadorDestaque
          rotulo="O.S. atrasadas" valor={formatQtd(totais.atrasadas)}
          tom={totais.atrasadas > 0 ? 'prejuizo' : undefined}
        />
        <IndicadorDestaque
          rotulo="Sem preço cadastrado" valor={formatQtd(totais.semPreco)}
          tom={totais.semPreco > 0 ? 'atencao' : undefined}
          explicacao="Facção sem preço faz a O.S. nascer sem valor, e o custo do serviço fica em branco até alguém cadastrar."
        />
      </div>

      <div className="filtros-linha">
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Nome, documento, contato ou cidade" />
        <Select value={filtroCategoria} onChange={(e) => setFiltroCategoria(e.target.value)} placeholder="Todas as categorias">
          {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </Select>
        <button type="button" className="btn-sec" onClick={() => setMostrarInativas((v) => !v)}>
          {mostrarInativas ? 'Ocultar inativas' : 'Mostrar inativas'}
        </button>
        <button type="button" className="btn-sec" onClick={() => setGerindoCategorias(true)}>
          <Tag size={15} /> Categorias
        </button>
        <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
          <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
        </button>
        <button type="button" className="btn-sec" onClick={importarFaccoesWik} disabled={importandoWik}
          title="Traz as facções do Wik (cadastro de Departamento). Cria as que faltam e vincula as de mesmo nome — não sobrescreve o que você já editou.">
          <Download size={15} className={importandoWik ? 'girando' : ''} /> {importandoWik ? 'Importando…' : 'Importar do Wik'}
        </button>
        <button type="button" className="btn" onClick={() => setEditando('novo')}>
          <Plus size={15} /> Nova facção
        </button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}
      {aviso && <p className="aviso-inline"><Info size={14} /> {aviso}</p>}
      {totais.semCategoria > 0 && (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> {totais.semCategoria} facção(ões) sem categoria. Quem passou por
          mais de uma etapa ficou sem categoria de propósito: chutar uma seria pior que a lacuna.
        </p>
      )}

      {carregando && <Skeleton height={220} />}
      {!carregando && faccoes.length === 0 && (
        <EstadoVazio
          Icone={Building2}
          titulo="Nenhuma facção cadastrada"
          descricao="A facção é quem costura, lava, borda ou estampa por fora. Cadastrada aqui, ela aparece nos combos da movimentação com a categoria dela, tem preço por etapa e passa a ter ranking de quebra, atraso e custo por peça."
          acaoLabel="Cadastrar a primeira"
          onAcao={() => setEditando('novo')}
          IconeAcao={Plus}
        />
      )}

      {!carregando && faccoes.length > 0 && (
        <div className="tabela-rolagem">
          <table className="tabela-nota">
            <thead>
              <tr>
                <th>Facção</th><th>Categoria</th><th>Contato</th><th>Cidade</th>
                <th className="num">O.S. abertas</th><th className="num">Peças fora</th>
                <th className="num">Quebra</th><th className="num">R$ / peça</th>
                <th className="num">Preços</th><th>Última remessa</th>
              </tr>
            </thead>
            <tbody>
              {faccoes.map((f) => (
                <tr key={f.id} className="linha-clicavel" onClick={() => setAberta(f.id)}>
                  <td>
                    {f.nome}
                    {!f.ativo && <span className="selo tone-neutro">inativa</span>}
                  </td>
                  <td>{f.categoria_nome || <span className="selo tone-atencao">sem categoria</span>}</td>
                  <td className="ink-soft">{[f.contato_nome, f.contato_telefone || f.telefone].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="ink-soft">{[f.cidade, f.uf].filter(Boolean).join('/') || '—'}</td>
                  <td className="num">{formatQtd(f.os_abertas)}</td>
                  <td className={`num ${Number(f.pecas_fora) > 0 ? 'ink-atencao' : ''}`}>{formatQtd(f.pecas_fora)}</td>
                  <td className={`num ${Number(f.quebra_fracao) > 0 ? 'ink-prejuizo' : ''}`}>
                    {f.quebra_fracao != null ? pct(f.quebra_fracao, 1) : '—'}
                  </td>
                  <td className="num">{f.custo_peca_medio != null ? brl(f.custo_peca_medio) : '—'}</td>
                  <td className="num">
                    {Number(f.precos_cadastrados) > 0
                      ? formatQtd(f.precos_cadastrados)
                      : <span className="selo tone-atencao" title="Sem preço, a O.S. desta facção nasce sem valor.">nenhum</span>}
                  </td>
                  <td>{f.ultima_remessa ? dataBr(f.ultima_remessa) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editando && (
        <NovaFaccaoModal
          faccaoId={editando === 'novo' ? null : editando}
          onFechar={() => setEditando(null)}
          onSalva={async () => { setEditando(null); await carregar(); onMudou?.(); }}
        />
      )}
      {aberta && (
        <FichaFaccao
          faccaoId={aberta} etapas={etapas} produtos={produtos}
          onFechar={() => setAberta(null)}
          onEditar={(id) => { setAberta(null); setEditando(id); }}
          onMudou={carregar}
        />
      )}
      {gerindoCategorias && (
        <Categorias
          categorias={categorias} etapas={etapas}
          onMudou={carregar}
          onFechar={() => { setGerindoCategorias(false); setAviso(''); }}
        />
      )}
    </>
  );
}
