# Verificação de Frete (web)

Site que pega as **planilhas de frete de referência** e uma **região (.geojson)** e mostra **quais CEPs da região
não têm frete** nas planilhas: mapa, indicadores, ranking por bairro/cidade e lista dos CEPs. No fim, dá para baixar
uma planilha `.xlsx` com tudo o que ficou sem cobertura.

Tudo roda no navegador: as planilhas **não são enviadas para nenhum servidor**. Só os endereços públicos do IBGE
e o mapa de fundo são baixados. Mesma base e mesmo visual do [Frete Regional](https://xandesheim.github.io/frete-regional/).

## 📋 Como usar

1. **Planilhas de frete de referência**: arraste ou escolha as planilhas (.xls, .xlsx ou .csv), quantas quiser.
2. **Região**: o `.geojson` com o polígono (dá para desenhar em <https://geojson.io>).
3. **Verificar cobertura**: aparece o relatório e os botões de download.

## ⚙️ Como a cobertura é calculada

1. Descobre quais municípios a região toca e baixa os endereços deles do **IBGE (CNEFE, Censo 2022)**.
2. Reduz a 1 ponto por CEP (mediana das coordenadas) e fica só com os CEPs **dentro do polígono**.
3. Para cada CEP, procura nas planilhas uma faixa `ZipCodeStart`–`ZipCodeEnd` que o contenha:

| Status | Quando |
|---|---|
| **Coberto** | alguma faixa contém o CEP |
| **Cobertura parcial (peso)** | coberto, mas só por linhas com `WeightEnd` menor que o maior `WeightEnd` das planilhas (só aparece se houver coluna de peso) |
| **Sem cobertura** | nenhuma faixa contém o CEP |

## 📥 O que vem na planilha (.xlsx)

| Aba | Conteúdo |
|---|---|
| CEPs sem cobertura | CEP, cidade, localidade/bairro, logradouro, nº de endereços (IBGE), lat/long |
| Faixas sem cobertura | CEPs sem cobertura agrupados em faixas `ZipCodeStart`/`ZipCodeEnd`. Uma faixa só junta CEPs seguidos se **não houver nenhum outro CEP conhecido no meio** (coberto ou fora da região), então dá para usar direto numa planilha de frete. |
| Cobertura parcial (peso) | só quando há coluna de peso |
| Resumo por cidade / por bairro | total, cobertos, sem cobertura, % e endereços afetados |
| Todos os CEPs da região | lista completa com o status |
| Sobre | data, arquivos usados e como ler |

Também dá para baixar os CEPs sem cobertura em `.geojson` (pontos) para abrir no geojson.io.

### Colunas reconhecidas automaticamente
| Função | Nomes aceitos (sem diferenciar maiúsculas/espaços/_) |
|---|---|
| CEP inicial | `ZipCodeStart`, `cep_inicio`, `cep_inicial` |
| CEP final | `ZipCodeEnd`, `cep_fim`, `cep_final` |
| Peso final (opcional) | `WeightEnd`, `peso_fim`, `peso_final` |

Para nomes diferentes, use um `config.json` em *Avançado*: `{ "cep_inicio": "De", "cep_fim": "Ate", "peso_fim": "PesoMax" }`.

## ⚠️ Limites

- CEPs que **não existem no CNEFE** (CEP novo depois do Censo, CEP exclusivo de grande usuário, caixa postal) não aparecem.
- O ponto de cada CEP é a mediana dos endereços; CEPs na borda do polígono podem cair de um lado ou do outro.
- Limite de 80 municípios por região. A cidade de São Paulo é o maior arquivo do IBGE (cerca de 177 MB) e demora na 1ª vez; depois fica salva no navegador.

## 🛠️ Desenvolvimento

Site estático, sem build: HTML + JavaScript, com [SheetJS](https://sheetjs.com), [fflate](https://github.com/101arrowz/fflate)
e [Leaflet](https://leafletjs.com) (mapa com fundo da CARTO/OpenStreetMap).

```powershell
python -m http.server 8000   # e abra http://localhost:8000
```

Para publicar no GitHub Pages: suba numa branch `main` e ative *Settings → Pages → Deploy from a branch*.
