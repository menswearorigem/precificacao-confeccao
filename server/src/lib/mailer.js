const nodemailer = require('nodemailer');

// Envio de e-mail por SMTP (Gmail, SendGrid, Mailgun — o que a empresa já
// tiver).
//
// O QUE MUDOU NA VARREDURA DE 03/09/2026: antes, sem SMTP configurado, o
// sistema escrevia um aviso no log do servidor e devolvia "enviamos o e-mail"
// pra pessoa. Ninguém lê o log do Render, então a recuperação de senha
// *parecia* funcionar e simplesmente não funcionava. Agora:
//
//   • enviarEmail devolve o motivo exato da falha em vez de fingir sucesso;
//   • quem chama decide o que mostrar (a tela de recuperação continua com
//     resposta genérica, pra não entregar quais nomes existem, mas o
//     administrador consegue ver a falha no histórico e na tela de teste);
//   • existe verificarSmtp() pra provar que a configuração está de pé ANTES
//     de alguém precisar dela de verdade.

let transportador = null;

function configurado() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransportador() {
  if (!configurado()) return null;
  if (transportador) return transportador;
  transportador = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  return transportador;
}

function remetente() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || null;
}

// Confere se dá pra conectar e autenticar no servidor de e-mail, sem mandar
// mensagem nenhuma. Usado pela tela de teste do administrador.
async function verificarSmtp() {
  if (!configurado()) {
    return {
      ok: false,
      configurado: false,
      motivo:
        'SMTP não configurado. Defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM nas variáveis de ambiente do serviço (Render → Environment).',
    };
  }
  if (!remetente()) {
    return { ok: false, configurado: true, motivo: 'Falta definir SMTP_FROM (ou SMTP_USER) — o e-mail precisa de um remetente.' };
  }
  try {
    await getTransportador().verify();
    return {
      ok: true,
      configurado: true,
      servidor: `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`,
      remetente: remetente(),
    };
  } catch (err) {
    return { ok: false, configurado: true, motivo: err.message };
  }
}

// Moldura HTML simples, na identidade do sistema (REGRA 3: couro, terracota,
// Inter). Cores fixas aqui de propósito — cliente de e-mail não lê variável
// CSS, e este arquivo não é interface do sistema.
function moldar({ titulo, corpoHtml, rodape }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f4f1ec;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2b2320;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fffdfa;border:1px solid #e3dcd2;border-radius:10px;overflow:hidden;">
    <tr><td style="background:#3b2a22;padding:18px 24px;color:#f2e7d8;font-size:15px;font-weight:600;letter-spacing:.3px;">HBN Hub</td></tr>
    <tr><td style="padding:26px 24px 8px;">
      <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#2b2320;">${titulo}</h1>
      ${corpoHtml}
    </td></tr>
    <tr><td style="padding:16px 24px 24px;color:#7a6d63;font-size:12px;line-height:1.6;border-top:1px solid #efe8de;">
      ${rodape || 'Esta mensagem foi enviada automaticamente pelo HBN Hub. Não responda a este e-mail.'}
    </td></tr>
  </table>
</body></html>`;
}

function botao(href, texto) {
  return `<p style="margin:22px 0;"><a href="${href}" style="display:inline-block;background:#b4552d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-size:14px;font-weight:600;">${texto}</a></p>`;
}

/**
 * Envia um e-mail. NÃO lança: devolve { enviado, motivo }.
 * Quem chama decide se mostra a falha ou engole (ver auth.routes.js).
 */
async function enviarEmail({ para, assunto, texto, html }) {
  const t = getTransportador();
  if (!t) {
    const motivo = 'SMTP não configurado no servidor (SMTP_HOST ausente).';
    console.error(`[mailer] ${motivo} E-mail para "${para}" (${assunto}) NÃO foi enviado.`);
    return { enviado: false, motivo };
  }
  if (!para || !String(para).includes('@')) {
    const motivo = 'A conta não tem um e-mail válido cadastrado.';
    console.error(`[mailer] ${motivo} (valor recebido: ${JSON.stringify(para)})`);
    return { enviado: false, motivo };
  }
  try {
    const info = await t.sendMail({
      from: remetente(),
      to: para,
      subject: assunto,
      text: texto,
      html: html || undefined,
    });
    return { enviado: true, id: info.messageId };
  } catch (err) {
    console.error(`[mailer] falha ao enviar para "${para}" (${assunto}):`, err.message);
    return { enviado: false, motivo: err.message };
  }
}

module.exports = { enviarEmail, verificarSmtp, configurado, moldar, botao, remetente };
