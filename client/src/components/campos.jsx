// ============================================================================
// Campos de cadastro com regra embutida — 10/09/2026
// ============================================================================
// Substituem o <input> cru em TODOS os módulos. A API é de propósito idêntica
// à do <input> que estava lá antes:
//
//     <input       value={c.nome} onChange={(e) => set({ nome: e.target.value })} />
//     <CampoNome   value={c.nome} onChange={(e) => set({ nome: e.target.value })} />
//
// — o `onChange` continua recebendo um objeto com `target.value`, só que já
// saneado pela regra do campo. Nenhuma tela precisou mudar a forma de salvar,
// e nenhuma tela repete a regra: ela mora em lib/campos.js.
//
// Onde o aviso aparece: como <Field> é uma coluna flex, o componente devolve
// um Fragment com o input e, abaixo dele, o aviso. Quando o campo está dentro
// de uma linha (CEP + botão "Buscar"), `.campo-aviso` ocupa a linha inteira
// (flex-basis: 100%) em vez de espremer o campo.

import { Fragment, useEffect, useState } from 'react';
import { Select, NumInput } from './ui.jsx';
import {
  LIMITES, UFS,
  soLetras, soTelefone, colapsarEspacos,
  mascaraCnpj, mascaraCpf, mascaraCpfCnpj, mascaraCep, mascaraTelefone,
  soDigitos, cnpjValido, cpfValido, emailValido,
  limitarDesconto, DESCONTO_MIN, DESCONTO_MAX,
} from '../lib/campos.js';

// Evento sintético mínimo — todas as chamadas do sistema leem só target.value
// (e, em alguns lugares, target.name).
const evento = (valor, name) => ({ target: { value: valor, name } });

function Aviso({ texto, tom = 'erro' }) {
  if (!texto) return null;
  return <span className={`campo-aviso campo-aviso-${tom}`}>{texto}</span>;
}

// ---------------------------------------------------------------------------
// Base: sanea a cada tecla, valida quando a pessoa sai do campo
// ---------------------------------------------------------------------------
// `sanear`   — roda a cada tecla (máscara, corte de letra, limite)
// `validar`  — roda no blur; devolve '' (ok) ou a mensagem de erro
// `aoSairOk` — transformação final quando o valor é válido (ex.: colapsar
//              espaço duplo em nome)
// `limparSeInvalido` — só o e-mail usa: valor inválido some pra ser reescrito
function CampoBase({
  value, onChange, onBlur, onFocus,
  sanear, validar, aoSairOk, limparSeInvalido = false,
  maxLength, className = '', name, ...props
}) {
  const [aviso, setAviso] = useState('');
  const [focado, setFocado] = useState(false);

  // Valor que chega de fora (carregou o cadastro do banco) também passa pela
  // máscara — senão um CNPJ gravado só com dígitos apareceria cru na tela.
  const exibido = focado ? String(value ?? '') : sanear(String(value ?? ''));

  useEffect(() => {
    if (!value) setAviso('');
  }, [value]);

  function aoDigitar(e) {
    const limpo = sanear(e.target.value);
    if (aviso) setAviso('');
    onChange?.(evento(limpo, name));
  }

  function aoSair(e) {
    setFocado(false);
    const bruto = String(value ?? '');
    // Valor que veio do banco antes desta regra existir (CNPJ só com dígitos,
    // nome com número no meio) é normalizado assim que a pessoa encosta no
    // campo — nunca na carga da tela, pra não marcar o cadastro como alterado
    // sozinho.
    const atual = sanear(bruto);
    const mensagem = validar ? validar(atual) : '';
    setAviso(mensagem);
    if (mensagem && limparSeInvalido) {
      onChange?.(evento('', name));
    } else {
      const final = !mensagem && aoSairOk ? aoSairOk(atual) : atual;
      if (final !== bruto) onChange?.(evento(final, name));
    }
    onBlur?.(e);
  }

  return (
    <Fragment>
      <input
        {...props}
        name={name}
        className={className}
        maxLength={maxLength}
        value={exibido}
        onChange={aoDigitar}
        onFocus={(e) => { setFocado(true); onFocus?.(e); }}
        onBlur={aoSair}
        aria-invalid={aviso ? 'true' : undefined}
      />
      <Aviso texto={aviso} />
    </Fragment>
  );
}

// ---------------------------------------------------------------------------
// Nome — 50 caracteres, só letras
// ---------------------------------------------------------------------------
// `pessoaFisica` (padrão: sim) é o que liga o "só letras". Continua sendo o
// mesmo campo, mas quando o cadastro está em PJ o rótulo vira "Razão Social" —
// e razão social de empresa brasileira tem número com frequência ("Origem 10
// Comércio LTDA", "3 Corações"). Recusar dígito ali impediria cadastrar o
// fornecedor exatamente como está na nota dele.
export function CampoNome({ limite = LIMITES.nome, pessoaFisica = true, ...props }) {
  return (
    <CampoBase
      {...props}
      maxLength={limite}
      sanear={pessoaFisica ? (v) => soLetras(v, limite) : (v) => String(v ?? '').slice(0, limite)}
      aoSairOk={colapsarEspacos}
    />
  );
}

// ---------------------------------------------------------------------------
// Nome fantasia — 50 caracteres (aceita número e símbolo: nome fantasia é
// marca, e marca tem "3 Corações", "H&M", "Loja 5")
// ---------------------------------------------------------------------------
export function CampoNomeFantasia({ limite = LIMITES.nomeFantasia, ...props }) {
  return (
    <CampoBase
      {...props}
      maxLength={limite}
      sanear={(v) => String(v ?? '').slice(0, limite)}
      aoSairOk={colapsarEspacos}
    />
  );
}

// Texto livre com teto de caracteres — para os campos que não são nome de
// pessoa mas também não podem crescer sem limite (nome de tabela, de kit, de
// depósito, de etapa…).
export function CampoTextoLimitado({ limite = LIMITES.nome, ...props }) {
  return (
    <CampoBase
      {...props}
      maxLength={limite}
      sanear={(v) => String(v ?? '').slice(0, limite)}
      aoSairOk={colapsarEspacos}
    />
  );
}

// ---------------------------------------------------------------------------
// CNPJ — 18 caracteres formatados, só número; inválido entra com aviso
// ---------------------------------------------------------------------------
function validarCnpj(valor) {
  const d = soDigitos(valor);
  if (d.length === 0) return '';
  if (d.length < 14) return 'CNPJ incompleto — são 14 números.';
  return cnpjValido(d) ? '' : 'CNPJ inválido — o dígito verificador não fecha. Foi salvo assim mesmo.';
}

export function CampoCnpj(props) {
  return (
    <CampoBase
      {...props}
      className={`mono${props.className ? ` ${props.className}` : ''}`}
      inputMode="numeric"
      placeholder={props.placeholder ?? '00.000.000/0000-00'}
      maxLength={LIMITES.cnpj}
      sanear={mascaraCnpj}
      validar={validarCnpj}
    />
  );
}

// ---------------------------------------------------------------------------
// CPF — 14 caracteres formatados, só número; inválido entra com aviso
// ---------------------------------------------------------------------------
function validarCpf(valor) {
  const d = soDigitos(valor);
  if (d.length === 0) return '';
  if (d.length < 11) return 'CPF incompleto — são 11 números.';
  return cpfValido(d) ? '' : 'CPF inválido — o dígito verificador não fecha. Foi salvo assim mesmo.';
}

export function CampoCpf(props) {
  return (
    <CampoBase
      {...props}
      className={`mono${props.className ? ` ${props.className}` : ''}`}
      inputMode="numeric"
      placeholder={props.placeholder ?? '000.000.000-00'}
      maxLength={LIMITES.cpf}
      sanear={mascaraCpf}
      validar={validarCpf}
    />
  );
}

// ---------------------------------------------------------------------------
// CPF ou CNPJ no mesmo campo (Cliente, Fornecedor, Facção)
// ---------------------------------------------------------------------------
// `pj` decide o rótulo e o teto; quando não é informado, a máscara troca
// sozinha ao passar de 11 dígitos.
export function CampoCpfCnpj({ pj, ...props }) {
  const fixo = pj === true || pj === false;
  return (
    <CampoBase
      {...props}
      className={`mono${props.className ? ` ${props.className}` : ''}`}
      inputMode="numeric"
      placeholder={props.placeholder ?? (fixo ? (pj ? '00.000.000/0000-00' : '000.000.000-00') : 'CPF ou CNPJ')}
      maxLength={fixo && !pj ? LIMITES.cpf : LIMITES.cnpj}
      sanear={fixo ? (pj ? mascaraCnpj : mascaraCpf) : mascaraCpfCnpj}
      validar={(v) => {
        const d = soDigitos(v);
        if (d.length === 0) return '';
        if (fixo) return pj ? validarCnpj(v) : validarCpf(v);
        if (d.length === 11) return validarCpf(v);
        if (d.length === 14) return validarCnpj(v);
        return 'Documento incompleto — CPF tem 11 números, CNPJ tem 14.';
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Telefone — 20 caracteres, sem letra
// ---------------------------------------------------------------------------
export function CampoTelefone(props) {
  return (
    <CampoBase
      {...props}
      className={`mono${props.className ? ` ${props.className}` : ''}`}
      inputMode="tel"
      placeholder={props.placeholder ?? '(00) 00000-0000'}
      maxLength={LIMITES.telefone}
      sanear={(v) => mascaraTelefone(soTelefone(v))}
      validar={(v) => {
        const d = soDigitos(v);
        if (d.length === 0) return '';
        return d.length >= 10 ? '' : 'Telefone incompleto — com DDD são pelo menos 10 números.';
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// E-mail — 50 caracteres, obrigatoriamente com "@"; inválido LIMPA o campo
// ---------------------------------------------------------------------------
export function CampoEmail(props) {
  return (
    <CampoBase
      {...props}
      type="email"
      inputMode="email"
      autoComplete={props.autoComplete ?? 'email'}
      placeholder={props.placeholder ?? 'nome@dominio.com.br'}
      maxLength={LIMITES.email}
      sanear={(v) => String(v ?? '').replace(/\s/g, '').slice(0, LIMITES.email)}
      validar={(v) => {
        if (!String(v ?? '').trim()) return '';
        if (!String(v).includes('@')) return 'E-mail precisa ter "@" — o campo foi limpo, escreva de novo.';
        return emailValido(v) ? '' : 'E-mail inválido — o campo foi limpo, escreva de novo.';
      }}
      limparSeInvalido
    />
  );
}

// ---------------------------------------------------------------------------
// CEP — 9 caracteres, sem letra
// ---------------------------------------------------------------------------
export function CampoCep(props) {
  return (
    <CampoBase
      {...props}
      className={`mono${props.className ? ` ${props.className}` : ''}`}
      inputMode="numeric"
      placeholder={props.placeholder ?? '00000-000'}
      maxLength={LIMITES.cep}
      sanear={mascaraCep}
      validar={(v) => {
        const d = soDigitos(v);
        if (d.length === 0) return '';
        return d.length === 8 ? '' : 'CEP incompleto — são 8 números.';
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Cidade — 35 caracteres, só letras
// ---------------------------------------------------------------------------
export function CampoCidade(props) {
  return (
    <CampoBase
      {...props}
      maxLength={LIMITES.cidade}
      sanear={(v) => soLetras(v, LIMITES.cidade)}
      aoSairOk={colapsarEspacos}
    />
  );
}

// ---------------------------------------------------------------------------
// UF — só as 27 siglas
// ---------------------------------------------------------------------------
// É um <Select>, não um <input>: digitar sigla livre foi justamente o que
// encheu o cadastro de "sp", "S.P." e "SÂO". O valor que já estava gravado e
// não é uma das 27 continua aparecendo (marcado), pra não sumir calado.
export function CampoUf({ value, onChange, disabled, className, style, placeholder = 'UF' }) {
  const atual = String(value ?? '').toUpperCase();
  const foraDaLista = atual && !UFS.includes(atual);
  return (
    <Fragment>
      <Select
        value={atual}
        onChange={onChange}
        disabled={disabled}
        className={className}
        style={style}
        placeholder={placeholder}
      >
        <option value="">—</option>
        {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
        {foraDaLista && <option value={atual}>{atual} (fora da lista)</option>}
      </Select>
      {foraDaLista && <Aviso texto="UF fora das 27 siglas — escolha a correta." />}
    </Fragment>
  );
}

// ---------------------------------------------------------------------------
// Desconto — 0 a 100
// ---------------------------------------------------------------------------
// Continua sendo o NumInput (mesma digitação em vírgula brasileira, mesmo
// "clica e limpa o 0,00"), só que preso no intervalo: digitar 150 devolve 100
// e avisa. `onChange` recebe number, como no NumInput.
export function CampoDesconto({ value, onChange, onBlur, suffix = '%', ...props }) {
  const [aviso, setAviso] = useState('');
  return (
    <Fragment>
      <NumInput
        {...props}
        value={value}
        suffix={suffix}
        onChange={(v) => {
          const preso = limitarDesconto(v);
          setAviso(v !== '' && Number(v) !== Number(preso)
            ? `Desconto vai de ${DESCONTO_MIN} a ${DESCONTO_MAX}.`
            : '');
          onChange?.(preso);
        }}
        onBlur={(e) => { setAviso(''); onBlur?.(e); }}
      />
      <Aviso texto={aviso} tom="atencao" />
    </Fragment>
  );
}
