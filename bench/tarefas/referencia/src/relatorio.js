import { formatarBRL } from './moeda.js';

export function resumoDePedidos(pedidos) {
  const centavos = { pago: 0, pendente: 0, cancelado: 0 };
  for (const { status, valor } of pedidos) {
    if (!(status in centavos)) throw new Error(`status desconhecido: ${status}`);
    centavos[status] += Math.round(valor * 100);
  }
  const reais = c => formatarBRL(c / 100);
  return {
    pago: reais(centavos.pago),
    pendente: reais(centavos.pendente),
    cancelado: reais(centavos.cancelado),
    total: reais(centavos.pago + centavos.pendente)
  };
}
