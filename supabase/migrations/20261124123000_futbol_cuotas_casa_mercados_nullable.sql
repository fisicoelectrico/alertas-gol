-- DECISIONES 77: el respaldo vacía cuotas_casa.mercados (null) después de verificar el archivo en Storage.
-- La columna era NOT NULL y la primera corrida real (24 nov) falló en el update sin vaciar nada.
alter table futbol.cuotas_casa alter column mercados drop not null;
