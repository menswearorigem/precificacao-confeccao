import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { UploadCloud, FileText } from 'lucide-react';

// Substituto do "Escolher arquivo / Nenhum arquivo escolhido" cru do
// navegador — mesma API de fora (a ref exposta É o <input type="file">
// de verdade, então `fileRef.current.files` e `fileRef.current.value = ''`
// continuam funcionando exatamente como antes em quem já usa isso).
// Aceita arrastar-e-soltar além do clique, mostra o(s) nome(s) do arquivo
// escolhido e valida a extensão na hora (antes de mandar pro servidor).
const FileDropzone = forwardRef(function FileDropzone(
  { accept, multiple, onChange, formatosTexto, className = '' },
  refExterno
) {
  const inputRef = useRef(null);
  const [nomes, setNomes] = useState([]);
  const [arrastando, setArrastando] = useState(false);
  const [erro, setErro] = useState('');

  useImperativeHandle(refExterno, () => inputRef.current);

  function extensaoValida(nomeArquivo) {
    if (!accept) return true;
    const extensoesAceitas = accept.split(',').map((a) => a.trim().toLowerCase());
    const extensao = `.${nomeArquivo.split('.').pop().toLowerCase()}`;
    return extensoesAceitas.includes(extensao);
  }

  function aplicarArquivos(files) {
    if (!files || files.length === 0) return;
    const invalido = Array.from(files).find((f) => !extensaoValida(f.name));
    if (invalido) {
      setErro(`"${invalido.name}" não é um formato aceito aqui (${accept}).`);
      setNomes([]);
      return;
    }
    setErro('');
    setNomes(Array.from(files).map((f) => f.name));
  }

  function aoTrocarInput(e) {
    aplicarArquivos(e.target.files);
    onChange?.(e);
  }

  function aoSoltar(e) {
    e.preventDefault();
    setArrastando(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0 || !inputRef.current) return;
    inputRef.current.files = files;
    aplicarArquivos(files);
    onChange?.({ target: inputRef.current });
  }

  return (
    <div
      className={`file-dropzone${arrastando ? ' is-arrastando' : ''}${erro ? ' is-erro' : ''} ${className}`}
      onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
      onDragLeave={() => setArrastando(false)}
      onDrop={aoSoltar}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={aoTrocarInput}
        className="file-dropzone-input"
        tabIndex={-1}
      />
      <UploadCloud size={22} className="file-dropzone-icone" />
      {nomes.length > 0 ? (
        <div className="file-dropzone-arquivos">
          {nomes.map((n) => (
            <span key={n} className="file-dropzone-nome"><FileText size={12} />{n}</span>
          ))}
          <span className="file-dropzone-trocar">Clique ou arraste pra trocar</span>
        </div>
      ) : (
        <div className="file-dropzone-texto">
          <strong>Arraste o arquivo aqui ou clique pra escolher</strong>
          {formatosTexto && <span>{formatosTexto}</span>}
        </div>
      )}
      {erro && <div className="file-dropzone-erro">{erro}</div>}
    </div>
  );
});

export default FileDropzone;
