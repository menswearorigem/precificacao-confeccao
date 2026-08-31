import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { api } from '../api/client';
import { Toggle } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

const TIPOS = [
  { tipo: 'categoria', label: 'Categorias' },
  { tipo: 'marca', label: 'Marcas' },
  { tipo: 'colecao', label: 'Coleções' },
  { tipo: 'linha', label: 'Linhas' },
  { tipo: 'material', label: 'Materiais' },
  { tipo: 'unidade', label: 'Unidades' },
  { tipo: 'tipo_custo_industrial', label: 'Tipos de Custo Industrial' },
  { tipo: 'operacao', label: 'Operações (Vendas)' },
  { tipo: 'canal_venda', label: 'Canais de Venda' },
  { tipo: 'forma_pagamento', label: 'Formas de Pagamento' },
  { tipo: 'condicao_pagamento', label: 'Condições de Pagamento' },
  { tipo: 'vendedor', label: 'Vendedores' },
  { tipo: 'categoria_compra', label: 'Categorias de Compra' },
];

function normalizarTexto(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export default function ListasPage() {
  const [tipoAtivo, setTipoAtivo] = useState('categoria');
  const [listasPorTipo, setListasPorTipo] = useState({});
  const [novoValor, setNovoValor] = useState('');
  const [busca, setBusca] = useState('');

  useEffect(() => {
    Promise.all(TIPOS.map(({ tipo }) => api.get(`/listas/${tipo}`).then((itens) => [tipo, itens])))
      .then((pares) => setListasPorTipo(Object.fromEntries(pares)));
  }, []);

  function itensDoTipo(tipo) {
    return listasPorTipo[tipo] || [];
  }

  function atualizarLista(tipo, atualizar) {
    setListasPorTipo((mapa) => ({ ...mapa, [tipo]: atualizar(mapa[tipo] || []) }));
  }

  const termo = normalizarTexto(busca);

  // Contagem por lista: nº de valores cadastrados (não é "quantos registros
  // usam este valor" — ver aviso abaixo, essa segunda métrica exigiria uma
  // consulta cruzando cada tipo com as tabelas que o referenciam, que não
  // existe hoje e está fora do escopo autorizado desta tarefa).
  const contagemPorTipo = useMemo(() => {
    const mapa = {};
    for (const { tipo } of TIPOS) {
      const itens = itensDoTipo(tipo);
      mapa[tipo] = termo ? itens.filter((i) => normalizarTexto(i.valor).includes(termo)).length : itens.length;
    }
    return mapa;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listasPorTipo, termo]);

  const itensExibidos = useMemo(() => {
    const itens = [...itensDoTipo(tipoAtivo)].sort((a, b) => (a.ordem - b.ordem) || (a.id - b.id));
    return termo ? itens.filter((i) => normalizarTexto(i.valor).includes(termo)) : itens;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listasPorTipo, tipoAtivo, termo]);

  const listaAtivaLabel = TIPOS.find((t) => t.tipo === tipoAtivo)?.label || '';

  async function addValor(e) {
    e.preventDefault();
    if (!novoValor.trim()) return;
    const itens = itensDoTipo(tipoAtivo);
    const created = await api.post(`/listas/${tipoAtivo}`, { valor: novoValor.trim(), ordem: itens.length });
    atualizarLista(tipoAtivo, (lista) => [...lista, created]);
    setNovoValor('');
  }

  async function renomear(item, valor) {
    if (!valor.trim() || valor === item.valor) return;
    const updated = await api.put(`/listas/${tipoAtivo}/${item.id}`, { valor: valor.trim() });
    atualizarLista(tipoAtivo, (lista) => lista.map((i) => (i.id === item.id ? updated : i)));
  }

  async function toggleAtivo(item) {
    const updated = await api.put(`/listas/${tipoAtivo}/${item.id}`, { ativo: !item.ativo });
    atualizarLista(tipoAtivo, (lista) => lista.map((i) => (i.id === item.id ? updated : i)));
  }

  async function remover(item) {
    const ok = await confirmar(
      `Desativar "${item.valor}"? Não é possível contar automaticamente quantos registros usam este valor nesta versão do sistema — por segurança, isto apenas desativa: nada é apagado, e produtos/pedidos que já usam "${item.valor}" continuam funcionando normalmente. Dá pra reativar depois.`,
      { confirmarTexto: 'Desativar', perigo: false }
    );
    if (!ok) return;
    await api.del(`/listas/${tipoAtivo}/${item.id}`);
    atualizarLista(tipoAtivo, (lista) => lista.map((i) => (i.id === item.id ? { ...i, ativo: false } : i)));
  }

  async function mover(item, direcao) {
    const itens = [...itensDoTipo(tipoAtivo)].sort((a, b) => (a.ordem - b.ordem) || (a.id - b.id));
    const idx = itens.findIndex((i) => i.id === item.id);
    const alvo = idx + direcao;
    if (alvo < 0 || alvo >= itens.length) return;
    const reordenado = [...itens];
    [reordenado[idx], reordenado[alvo]] = [reordenado[alvo], reordenado[idx]];
    const alterados = reordenado
      .map((i, novaOrdem) => ({ i, novaOrdem }))
      .filter(({ i, novaOrdem }) => Number(i.ordem) !== novaOrdem);
    const atualizados = await Promise.all(
      alterados.map(({ i, novaOrdem }) => api.put(`/listas/${tipoAtivo}/${i.id}`, { ordem: novaOrdem }))
    );
    const porId = new Map(atualizados.map((r) => [r.id, r]));
    atualizarLista(tipoAtivo, (lista) => lista.map((i) => porId.get(i.id) || i));
  }

  return (
    <div className="page-wide">
      <h2>Listas</h2>
      <p className="page-sub">
        Valores usados nos menus suspensos em todo o sistema. Você pode desativar um valor sem
        perder o histórico dos produtos que já o usam, ou reordenar como aparece nos menus.
      </p>

      <div className="cfg-busca" style={{ marginBottom: 14, maxWidth: 320 }}>
        <Search size={14} />
        <input placeholder="Buscar em todas as listas…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ width: '100%' }} />
      </div>

      <div className="cfg-listas-grid">
        <div className="cfg-listas-indice">
          {TIPOS.map(({ tipo, label }) => (
            <button
              key={tipo}
              type="button"
              className={'cfg-listas-indice-item' + (tipo === tipoAtivo ? ' is-ativo' : '')}
              onClick={() => setTipoAtivo(tipo)}
            >
              <span>{label}</span>
              <span className="cfg-listas-indice-contagem">{contagemPorTipo[tipo] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="card">
          <div className="card-head">{listaAtivaLabel}</div>
          <p className="page-sub" style={{ marginTop: -4 }}>
            Quantos registros usam cada valor não pode ser contado automaticamente nesta versão —
            por isso desativar (em vez de apagar) é sempre a opção seletiva aqui.
          </p>

          <table className="data-table">
            <thead><tr><th /><th>Valor</th><th>Ativo?</th><th /></tr></thead>
            <tbody>
              {itensExibidos.map((item) => (
                <tr key={item.id} className="cfg-linha-hover">
                  <td style={{ width: 40 }}>
                    <div className="cfg-listas-alca">
                      <button type="button" className="icon-btn" onClick={() => mover(item, -1)} title="Mover pra cima"><ChevronUp size={13} /></button>
                      <button type="button" className="icon-btn" onClick={() => mover(item, 1)} title="Mover pra baixo"><ChevronDown size={13} /></button>
                    </div>
                  </td>
                  <td>
                    <input
                      defaultValue={item.valor}
                      key={item.id + item.valor}
                      onBlur={(e) => renomear(item, e.target.value)}
                      style={{ opacity: item.ativo ? 1 : 0.6 }}
                    />
                  </td>
                  <td>
                    <label className="toggle">
                      <Toggle checked={item.ativo} onChange={() => toggleAtivo(item)} />
                      {item.ativo ? 'Sim' : 'Não'}
                    </label>
                  </td>
                  <td><button className="icon-btn cfg-lixeira" onClick={() => remover(item)}><Trash2 size={13} /></button></td>
                </tr>
              ))}
              {itensExibidos.length === 0 && (
                <tr><td colSpan="4" style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>
                  {termo ? 'Nenhum valor encontrado pra essa busca.' : 'Nenhum valor cadastrado.'}
                </td></tr>
              )}
            </tbody>
          </table>

          <form onSubmit={addValor} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              placeholder={`Novo valor em "${listaAtivaLabel}"`}
              value={novoValor}
              onChange={(e) => setNovoValor(e.target.value)}
            />
            <button className="btn btn-dashed" type="submit"><Plus size={13} /> Adicionar</button>
          </form>
        </div>
      </div>
    </div>
  );
}
