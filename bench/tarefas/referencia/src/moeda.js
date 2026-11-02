export function formatarBRL(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) throw new TypeError('valor invalido');
  // Half away from zero on the decimal text, not on the binary value: 0.125 * 100 is exact,
  // but 1.005 * 100 is not, and toFixed would round it down.
  const centavos = Math.round(Math.abs(valor) * 100 + 1e-9);
  if (centavos === 0) return 'R$ 0,00';
  const inteiro = String(Math.floor(centavos / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const texto = `R$ ${inteiro},${String(centavos % 100).padStart(2, '0')}`;
  return valor < 0 ? `-${texto}` : texto;
}
