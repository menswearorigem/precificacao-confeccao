import logoWik from '../assets/logos/wik.png';

// Logo oficial do Wik (Wiki Sistemas), enviada pela dona em 16/09/2026 —
// substitui a nuvem genérica que marcava tudo o que vem do ERP. Fica num
// fundo branco redondo para funcionar igual no tema claro e no escuro.
export default function LogoWik({ size = 14, className = '', title = 'Wik' }) {
  return (
    <img
      src={logoWik}
      alt=""
      title={title}
      width={size}
      height={size}
      className={`logo-wik ${className}`}
      style={{ '--logo-size': `${size}px` }}
      draggable={false}
    />
  );
}
