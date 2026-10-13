# TrainRadar

Flightradar, fast för tåg. Alla tåg i Sverige och Finland i realtid på en interaktiv 3D-karta.

This project is connected to [Lovable](https://lovable.dev/projects/86959f13-7ad6-42a8-8d48-bfa93eb9eeff). Changes made in Lovable are committed straight to this repository, and pushes here sync back.

## Funktioner

- **3D-karta** (MapLibre GL): jordglob, terräng med höjddata, 3D-byggnader och himmel/atmosfär. Satellitbild är förvald och kan växlas mot en mörk vektorkarta.
- **Järnvägsnätet** från OpenStreetMap ritas ut ovanpå kartan.
- **Livetåg**: positionerna uppdateras var 10:e sekund, och tågen glider mjukt mellan uppdateringarna. De är färgade efter försening och har en pil som visar färdriktningen. När man zoomar in blir de 3D-kroppar.
- **Klick på ett tåg**: en infopanel visar senaste och nästa station, slutstation, försening, hastighet, riktning, en hastighetsgraf och tågets spår på kartan.
- **Följ / 3D-vy**: kameran följer tåget, eller ger en chase-cam bakom tåget.
- **Sök** på tågnummer, operatör eller station. Tryck `/` för att fokusera sökfältet och `Esc` för att avmarkera.
- **Filter**: land och förseningsnivå, där legenden går att klicka på.
- **Statistik**: punktlighet, snittförsening, snabbaste tåget och de mest försenade tågen.
- **Delbara länkar**: `/?train=<id>` öppnar direkt på ett tåg.

## Datakällor

| Land       | Källa                                                                                      | Nyckel                 |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| 🇫🇮 Finland | [Fintraffic Digitraffic](https://www.digitraffic.fi/en/railway-traffic/)                   | Ingen, fungerar direkt |
| 🇸🇪 Sverige | [Trafikverket öppet API](https://data.trafikverket.se) (TrainPosition + TrainAnnouncement) | Gratis, se nedan       |

### Svenska tåg: Trafikverket-nyckel

1. Skapa ett konto och en nyckel på <https://data.trafikverket.se>.
2. Sätt miljövariabeln `TRAFIKVERKET_API_KEY` på servern, i Lovable som en secret. Lokalt sätter du den i `.env.local`.

Utan nyckel visar appen bara finska tåg. Den svenska flaggan i headern får då en gul prick.

Kartdata: © OpenStreetMap-bidragsgivare, CARTO, OpenFreeMap, Esri (satellit), Mapzen/AWS (terräng).

## Arkitektur

```
src/lib/trains/types.ts               gemensamt Train-format
src/lib/trains/digitraffic.server.ts  adapter för Finland
src/lib/trains/trafikverket.server.ts adapter för Sverige
src/lib/trains/aggregate.server.ts    kör alla adaptrar, cachar 10 s, räknar ut riktning
src/routes/api/trains.ts              GET /api/trains → { trains, sources, generatedAt }
src/components/radar/TrainMap.tsx     3D-karta, lager, animation, kamera
src/components/radar/TrainPanel.tsx   infopanel för valt tåg
src/routes/index.tsx                  sidan: sök, filter, statistik, kontroller
```

Ett nytt land, till exempel Norge via Entur, blir en ny adapter som returnerar `Train[]` och läggs till i `SOURCES` i `aggregate.server.ts`.

## Utveckling

```sh
bun install   # eller npm i
bun run dev
bun run test
```
