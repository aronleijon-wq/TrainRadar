import { describe, expect, it } from "vitest";

import { bearingBetween, fillBearings } from "./aggregate.server";
import { delayLevel, formatDelay } from "./delay";
import { normalizeDigitraffic, type DtLocation, type DtTrain } from "./digitraffic.server";
import { lerpBearing, trainFootprint } from "./geo";
import {
  normalizeTrafikverket,
  parseWgs84,
  type TvAnnouncement,
  type TvPosition,
} from "./trafikverket.server";
import type { Train } from "./types";

describe("Trafikverket adapter", () => {
  it("parses WGS84 points", () => {
    expect(parseWgs84("POINT (18.0583 59.3313)")).toEqual([18.0583, 59.3313]);
    expect(parseWgs84("garbage")).toBeNull();
    expect(parseWgs84(undefined)).toBeNull();
  });

  it("joins positions with announcements and station names", () => {
    const positions: TvPosition[] = [
      {
        Train: {
          AdvertisedTrainNumber: "537",
          OperationalTrainDepartureDate: "2026-10-13T00:00:00.000+02:00",
        },
        Position: { WGS84: "POINT (17.6389 59.8586)" },
        TimeStamp: "2026-10-13T21:40:00.000+02:00",
        Bearing: 12,
        Speed: 187,
      },
      { Train: { AdvertisedTrainNumber: "999" }, Position: {} },
    ];
    const passed: TvAnnouncement[] = [
      {
        AdvertisedTrainIdent: "537",
        ScheduledDepartureDateTime: "2026-10-13T00:00:00.000+02:00",
        AdvertisedTimeAtLocation: "2026-10-13T21:30:00.000+02:00",
        TimeAtLocation: "2026-10-13T21:37:00.000+02:00",
        LocationSignature: "U",
        Operator: "SJ",
        ProductInformation: [{ Code: "PNA014", Description: "SJ Snabbtåg" }],
        ToLocation: [{ LocationName: "Sun", Priority: 1, Order: 0 }],
      },
      // Older, earlier stop — must not override the latest one above.
      {
        AdvertisedTrainIdent: "537",
        ScheduledDepartureDateTime: "2026-10-13T00:00:00.000+02:00",
        AdvertisedTimeAtLocation: "2026-10-13T21:00:00.000+02:00",
        TimeAtLocation: "2026-10-13T21:00:00.000+02:00",
        LocationSignature: "Cst",
      },
    ];
    const upcoming: TvAnnouncement[] = [
      {
        AdvertisedTrainIdent: "537",
        ScheduledDepartureDateTime: "2026-10-13T00:00:00.000+02:00",
        LocationSignature: "G",
      },
    ];
    const names = new Map([
      ["U", "Uppsala C"],
      ["G", "Gävle C"],
      ["Sun", "Sundsvall C"],
    ]);

    const [train, ...rest] = normalizeTrafikverket(positions, passed, upcoming, names);
    expect(rest).toHaveLength(0);
    expect(train).toMatchObject({
      id: "trafikverket:2026-10-13:537",
      country: "SE",
      trainNo: "537",
      operator: "SJ",
      product: "SJ Snabbtåg",
      lat: 59.8586,
      lon: 17.6389,
      speed: 187,
      bearing: 12,
      delayMin: 7,
      lastStation: "Uppsala C",
      nextStation: "Gävle C",
      destination: "Sundsvall C",
    });
  });
});

describe("Digitraffic adapter", () => {
  it("merges positions with GraphQL details", () => {
    const locations: DtLocation[] = [
      {
        trainNumber: 45,
        departureDate: "2026-10-13",
        timestamp: "2026-10-13T18:40:00.000Z",
        location: { type: "Point", coordinates: [24.94, 60.17] },
        speed: 120,
      },
      {
        trainNumber: 9001,
        departureDate: "2026-10-13",
        timestamp: "2026-10-13T18:40:00.000Z",
        location: { type: "Point", coordinates: [25.5, 61.0] },
        speed: 0,
      },
    ];
    const details: DtTrain[] = [
      {
        trainNumber: 45,
        departureDate: "2026-10-13",
        operator: { shortCode: "vr" },
        trainType: { name: "IC" },
        timeTableRows: [
          {
            type: "DEPARTURE",
            trainStopping: true,
            commercialStop: true,
            scheduledTime: "2026-10-13T18:00:00.000Z",
            actualTime: "2026-10-13T18:04:00.000Z",
            differenceInMinutes: 4,
            station: { name: "Helsinki asema", shortCode: "HKI" },
          },
          {
            type: "ARRIVAL",
            trainStopping: false,
            scheduledTime: "2026-10-13T18:30:00.000Z",
            station: { name: "Kerava", shortCode: "KE" },
          },
          {
            type: "ARRIVAL",
            trainStopping: true,
            commercialStop: true,
            scheduledTime: "2026-10-13T19:00:00.000Z",
            station: { name: "Tampere asema", shortCode: "TPE" },
          },
        ],
      },
    ];

    const [ic, bare] = normalizeDigitraffic(locations, details);
    expect(ic).toMatchObject({
      id: "digitraffic:2026-10-13:45",
      country: "FI",
      trainNo: "IC 45",
      operator: "VR",
      product: "IC",
      lat: 60.17,
      lon: 24.94,
      delayMin: 4,
      lastStation: "Helsinki",
      nextStation: "Tampere",
      destination: "Tampere",
    });
    expect(bare).toMatchObject({ trainNo: "9001", operator: null, delayMin: null });
  });
});

describe("bearings", () => {
  it("computes compass bearings", () => {
    expect(bearingBetween([18, 59], [18, 60])).toBeCloseTo(0, 0);
    expect(bearingBetween([18, 59], [19, 59])).toBeCloseTo(90, -1);
  });

  it("derives bearing from consecutive fixes when the source has none", () => {
    const train = (lat: number): Train => ({
      id: "digitraffic:x:1",
      country: "FI",
      source: "digitraffic",
      trainNo: "1",
      departureDate: null,
      operator: null,
      product: null,
      lat,
      lon: 25,
      speed: 100,
      bearing: null,
      delayMin: null,
      lastStation: null,
      nextStation: null,
      destination: null,
      updatedAt: "",
    });
    expect(fillBearings([train(60)])[0]!.bearing).toBeNull();
    expect(fillBearings([train(60.01)])[0]!.bearing).toBeCloseTo(0, 0);
    // Standing still keeps the last known bearing.
    expect(fillBearings([train(60.01)])[0]!.bearing).toBeCloseTo(0, 0);
  });

  it("interpolates bearings along the short arc", () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpBearing(10, 350, 0.5)).toBeCloseTo(0);
  });

  it("builds a closed train footprint", () => {
    const ring = trainFootprint([18, 59], 45);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring).toHaveLength(6);
  });
});

describe("delay levels", () => {
  it("buckets delays", () => {
    expect(delayLevel(null)).toBe("unknown");
    expect(delayLevel(-3)).toBe("onTime");
    expect(delayLevel(2)).toBe("onTime");
    expect(delayLevel(4)).toBe("minor");
    expect(delayLevel(12)).toBe("moderate");
    expect(delayLevel(40)).toBe("major");
    expect(formatDelay(7)).toBe("+7 min");
    expect(formatDelay(-2)).toBe("2 min tidig");
  });
});
