const nodemailer = require('nodemailer');

// Envio de e-mail via SMTP genérico (Gmail, SendGrid, Mailgun, etc. — o
// que a empresa já tiver). Sem SMTP_HOST configurado, não trava o
// sistema: só avisa no log do servidor e segue sem enviar, pra não
// quebrar nada em ambiente de desenvolvimento ou antes da configuração
// em produção.

let transportador = null;

function getTransportador() {
  if (!process.env.SMTP_HOST) return null;
  if (transportador) return transportador;
  transportador = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transportador;
}

async function enviarEmail({ para, assunto, texto }) {
  const t = getTransportador();
  if (!t) {
    console.warn(
      `[mailer] SMTP não configurado (defina SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM nas variáveis de ambiente) — e-mail para "${para}" com assunto "${assunto}" NÃO foi enviado.`
    );
    return { enviado: false };
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: para,
    subject: assunto,
    text: texto,
  });
  return { enviado: true };
}

module.exports = { enviarEmail };
