import { useEffect, useState } from 'react';
import { X, Check, Plus, AlertTriangle, Building2 } from 'lucide-react';
import { api } from '../api/client';
import { Field, Select, NumInput, Checkbox } from './ui';
import { CampoNome, CampoNomeFantasia, CampoCpfCnpj, CampoTelefone, CampoEmail, CampoCep, CampoCidade, CampoUf } from './campos';

// Cadastro de facção — o formulário completo, usado em três lugares.
//
// O dono pediu duas coisas que parecem diferentes e são a mesma:
//   1. uma aba de cadastro de facção no módulo de Produção;
//   2. poder criar uma facção NA HORA de gerar a movimentação, sem sair da tela.
//
// Um componente só resolve as duas. O que muda entre os usos é o `compacto`,
// que esconde o que não é necessário para cadastrar às pressas — e nunca
// esconde o que é obrigatório, para o cadastro rápido não gerar uma facção pela
// metade que alguém teria de completar depois (e não completa).
//
// Os campos são exatamente os que ela listou: CNPJ, nome, razão social, campos
// adicionais, contato, endereço, forma de pagamento padrão, chave PIX e
// observações — mais a categoria, que é o que permite perguntar "quanto gastei
// com lavanderia este mês".

const PIX_TIPOS = [
  { valor: 'cnpj', rotulo: 'CNPJ' },
  { valor: 'cpf', rotulo: 'CPF' },
  { valor: 'telefone', rotulo: 'Telefone' },
  { valor: 'email', rotulo: 'E-mail' },
  { valor: 'aleatoria', rotulo: 'Chave aleatória' },
];

const FORMAS_PAGAMENTO = ['PIX', 'Transferência', 'Dinheiro', 'Boleto', 'Cheque'];

function vazia() {
  return {
    tipo_pessoa: 'PJ', nome: '', razao_social: '', nome_fantasia: '', cpf_cnpj: '',
    ie: '', ie_isento: false, telefone: '', email: '',
    contato_nome: '', contato_telefone: '',
    cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '',
    faccao_categoria_id: '', forma_pagamento_padrao: '', condicao_pagamento_padrao: '',
    chave_pix: '', pix_tipo: '', dados_bancarios: '', faccao_capacidade_mes: '',
    observacoes: '', ativo: true,
  };
}

export default function NovaFaccaoModal({ faccaoId, compacto = false, onFechar, onSalva }) {
  const [form, setForm] = useState(vazia());
  const [adicionais, setAdicionais] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [erro, setErro] = useState('');
  const [duplicado, setDuplicado] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(!!faccaoId);
  const [novaCategoria, setNovaCategoria] = useState('');

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }));

  useEffect(() => {
    api.get('/faccoes/categorias').then(setCategorias).catch(() => setCategorias([]));
  }, []);

  useEffect(() => {
    if (!faccaoId) return;
    setCarregando(true);
    api.get(`/faccoes/${faccaoId}`)
      .then((r) => {
        const f = r.faccao;
        setForm({
          ...vazia(),
          ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ?? ''])),
          ativo: f.ativo !== false,
          ie_isento: f.ie_isento === true,
        });
        setAdicionais(Object.entries(f.campos_adicionais || {}).map(([chave, valor]) => ({ chave, valor: String(valor) })));
      })
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [faccaoId]);

  async function criarCategoria() {
    const nome = novaCategoria.trim();
    if (!nome) return;
    try {
      const c = await api.post('/faccoes/categorias', { nome });
      setCategorias((atual) => [...atual, c]);
      setForm((f) => ({ ...f, faccao_categoria_id: c.id }));
      setNovaCategoria('');
    } catch (e) { setErro(e.message); }
  }

  async function salvar(aceitarRepetido = false) {
    setErro('');
    setSalvando(true);
    try {
      const corpo = {
        ...form,
        faccao_categoria_id: form.faccao_categoria_id ? Number(form.faccao_categoria_id) : null,
        faccao_capacidade_mes: form.faccao_capacidade_mes === '' ? null : Number(form.faccao_capacidade_mes),
        campos_adicionais: Object.fromEntries(
          adicionais.filter((a) => a.chave.trim()).map((a) => [a.chave.trim(), a.valor])
        ),
        aceitar_documento_repetido: aceitarRepetido,
      };
      const salva = faccaoId
        ? await api.put(`/faccoes/${faccaoId}`, corpo)
        : await api.post('/faccoes', corpo);
      onSalva(salva);
    } catch (e) {
      setErro(e.message);
      if (e.data?.exige === 'aceitar_documento_repetido') setDuplicado(e.data.existente || true);
    } finally {
      setSalvando(false);
    }
  }

  const pj = form.tipo_pessoa === 'PJ';

  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
      <div className="anuncio-painel painel-largo">
        <header className="anuncio-painel-topo">
          <h2>
            <Building2 size={18} /> {faccaoId ? 'Facção' : 'Nova facção'}
          </h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>

        <div className="anuncio-painel-corpo">
          {carregando && <p className="ink-soft">Carregando…</p>}

          <h3 className="card-titulo">Identificação</h3>
          <div className="form-linha">
            <Field label="Tipo de pessoa">
              <Select value={form.tipo_pessoa} onChange={set('tipo_pessoa')}>
                <option value="PJ">Pessoa jurídica</option>
                <option value="PF">Pessoa física</option>
              </Select>
            </Field>
            <Field label="Nome" hint="Como a casa chama esta facção.">
              <CampoNome className="input" value={form.nome} onChange={set('nome')} placeholder="Tânia Moura" />
            </Field>
            {pj && (
              <Field label="Razão social" hint="O nome que sai na nota.">
                <CampoNome className="input" pessoaFisica={false} value={form.razao_social} onChange={set('razao_social')} />
              </Field>
            )}
            <Field label={pj ? 'CNPJ' : 'CPF'} hint="Conferido na hora: dígito verificador errado só apareceria na emissão da nota de remessa.">
              <CampoCpfCnpj className="input" pj={pj} value={form.cpf_cnpj} onChange={set('cpf_cnpj')} />
            </Field>
            <Field label="Categoria" hint="Costureira, lavanderia, bordado…">
              <Select value={form.faccao_categoria_id} onChange={set('faccao_categoria_id')} placeholder="Sem categoria">
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </Select>
            </Field>
          </div>

          <div className="painel-acoes-inline">
            <input
              className="input" style={{ maxWidth: 220 }}
              value={novaCategoria} onChange={(e) => setNovaCategoria(e.target.value)}
              placeholder="Criar categoria nova"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); criarCategoria(); } }}
            />
            <button type="button" className="btn-sec" disabled={!novaCategoria.trim()} onClick={criarCategoria}>
              <Plus size={14} /> Criar categoria
            </button>
          </div>

          {!compacto && (
            <div className="form-linha">
              <Field label="Nome fantasia">
                <CampoNomeFantasia className="input" value={form.nome_fantasia} onChange={set('nome_fantasia')} />
              </Field>
              <Field label="Inscrição estadual">
                <input className="input" value={form.ie} onChange={set('ie')} disabled={form.ie_isento} />
              </Field>
              <Field label=" ">
                <label className="check-linha">
                  <Checkbox checked={form.ie_isento} onChange={(e) => setForm((f) => ({ ...f, ie_isento: e.target.checked }))} />
                  Isenta de IE
                </label>
              </Field>
            </div>
          )}

          <h3 className="card-titulo">Contato</h3>
          <div className="form-linha">
            <Field label="Pessoa de contato" hint="Com quem se fala — quase nunca é a empresa.">
              <CampoNome className="input" value={form.contato_nome} onChange={set('contato_nome')} />
            </Field>
            <Field label="Telefone do contato">
              <CampoTelefone className="input" value={form.contato_telefone} onChange={set('contato_telefone')} />
            </Field>
            <Field label="Telefone">
              <CampoTelefone className="input" value={form.telefone} onChange={set('telefone')} />
            </Field>
            <Field label="E-mail">
              <CampoEmail className="input" value={form.email} onChange={set('email')} />
            </Field>
          </div>

          <h3 className="card-titulo">Endereço</h3>
          <div className="form-linha">
            <Field label="CEP"><CampoCep className="input" value={form.cep} onChange={set('cep')} /></Field>
            <Field label="Logradouro"><input className="input" value={form.logradouro} onChange={set('logradouro')} /></Field>
            <Field label="Número"><input className="input" value={form.numero} onChange={set('numero')} /></Field>
            <Field label="Complemento"><input className="input" value={form.complemento} onChange={set('complemento')} /></Field>
            <Field label="Bairro"><input className="input" value={form.bairro} onChange={set('bairro')} /></Field>
            <Field label="Cidade"><CampoCidade className="input" value={form.cidade} onChange={set('cidade')} /></Field>
            <Field label="UF"><CampoUf value={form.uf} onChange={(e) => setForm((f) => ({ ...f, uf: e.target.value }))} /></Field>
          </div>

          <h3 className="card-titulo">Pagamento</h3>
          <div className="form-linha">
            <Field label="Forma de pagamento padrão" hint="Como se paga: PIX, transferência…">
              <Select value={form.forma_pagamento_padrao} onChange={set('forma_pagamento_padrao')} placeholder="Não definida">
                {FORMAS_PAGAMENTO.map((f) => <option key={f} value={f}>{f}</option>)}
              </Select>
            </Field>
            <Field label="Condição de pagamento" hint="Quando se paga: à vista, 15 dias…">
              <input className="input" value={form.condicao_pagamento_padrao} onChange={set('condicao_pagamento_padrao')} placeholder="15 dias" />
            </Field>
            <Field label="Tipo da chave PIX">
              <Select value={form.pix_tipo} onChange={set('pix_tipo')} placeholder="Não definido">
                {PIX_TIPOS.map((p) => <option key={p.valor} value={p.valor}>{p.rotulo}</option>)}
              </Select>
            </Field>
            <Field label="Chave PIX">
              <input className="input" value={form.chave_pix} onChange={set('chave_pix')} />
            </Field>
          </div>

          {!compacto && (
            <div className="form-linha">
              <Field label="Dados bancários" hint="Banco, agência e conta, quando o pagamento não é por PIX.">
                <input className="input" value={form.dados_bancarios} onChange={set('dados_bancarios')} />
              </Field>
              <Field label="Capacidade por mês (peças)" hint="Em branco = não declarada. A tela escreve isso em vez de supor capacidade infinita.">
                <NumInput step="1" value={form.faccao_capacidade_mes} onChange={(v) => setForm((f) => ({ ...f, faccao_capacidade_mes: v }))} />
              </Field>
            </div>
          )}

          {!compacto && (
            <>
              <h3 className="card-titulo">Campos adicionais</h3>
              <p className="ink-soft ajuda-bloco">
                O que esta casa precisa saber e o sistema não tem como adivinhar: número de
                máquinas, dia de coleta, se retira ou entrega.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead><tr><th>Campo</th><th>Valor</th><th /></tr></thead>
                  <tbody>
                    {adicionais.map((a, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input" value={a.chave} placeholder="máquinas"
                            onChange={(e) => setAdicionais((l) => l.map((x, j) => (j === i ? { ...x, chave: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <input
                            className="input" value={a.valor} placeholder="12"
                            onChange={(e) => setAdicionais((l) => l.map((x, j) => (j === i ? { ...x, valor: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <button type="button" className="btn-icone" aria-label="Remover campo"
                            onClick={() => setAdicionais((l) => l.filter((_, j) => j !== i))}><X size={15} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn-sec" onClick={() => setAdicionais((l) => [...l, { chave: '', valor: '' }])}>
                <Plus size={14} /> Mais um campo
              </button>
            </>
          )}

          <Field label="Observações">
            <textarea className="input" rows={2} value={form.observacoes} onChange={set('observacoes')} />
          </Field>

          {faccaoId && (
            <label className="check-linha">
              <Checkbox checked={form.ativo} onChange={(e) => setForm((f) => ({ ...f, ativo: e.target.checked }))} />
              Ativa — some das listas de escolha quando desmarcada, e o histórico continua respondendo por ela.
            </label>
          )}

          {erro && <p className="erro-inline">{erro}</p>}
          {duplicado && (
            <div className="bloco-alerta">
              <p><AlertTriangle size={15} /> Já existe um cadastro com este documento.</p>
              <p className="ink-soft">
                Às vezes é proposital — a mesma pessoa é facção e fornecedora de aviamento, e a
                casa quer os dois cadastros separados. Se for o caso, confirme.
              </p>
              <button type="button" className="btn-sec" onClick={() => { setDuplicado(null); salvar(true); }}>
                Cadastrar assim mesmo
              </button>
            </div>
          )}
        </div>

        <footer className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn" disabled={!form.nome.trim() || salvando} onClick={() => salvar(false)}>
            <Check size={15} /> {faccaoId ? 'Salvar' : 'Cadastrar facção'}
          </button>
        </footer>
      </div>
    </div>
  );
}
