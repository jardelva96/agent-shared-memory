export function validarCPF(cpf) {
  if (typeof cpf !== 'string' || !/^[\d.-]+$/.test(cpf)) return false;
  const d = cpf.replace(/[.-]/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digito = n => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}
