// =====================================================================
//  VERSÕES DE MENSAGEM
//  ---------------------------------------------------------------------
//  Escreva quantas versões quiser. O script sorteia UMA por contato,
//  o que ajuda a variar o texto (reduz cara de "robô").
//  Use {nome} onde quiser inserir o nome da pessoa (vem do contatos.csv).
//  Você pode usar quebras de linha normalmente.
// =====================================================================

const versoes = [
  `Oi {nome}, tudo bem? Passando aqui pra te falar de uma novidade 😊`,

  `E aí {nome}! Beleza? Queria te contar uma coisa rapidinho.`,

  `Olá {nome}, tudo certo? Tenho uma novidade que acho que vai te interessar.`,

  `Fala {nome}! Como você está? Separei um recado especial pra você.`,
];

module.exports = versoes;
