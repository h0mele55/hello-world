/**
 * Unit tests for the spatial-file parser (src/lib/spatial/parse.ts).
 * Pure module — no DB, no network. Covers GeoJSON + KML parsing,
 * Polygon→MultiPolygon normalization, format detection, bounds, and
 * the error paths.
 */
import {
    detectFormat,
    normalizeToParcels,
    parseGeoJson,
    parseKml,
    parseSpatialFile,
    SpatialParseError,
} from '@/lib/spatial/parse';

const polygonFC = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { name: 'North 40', crop: 'wheat' },
            geometry: {
                type: 'Polygon',
                coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
            },
        },
    ],
};

describe('detectFormat', () => {
    it('detects by extension', () => {
        expect(detectFormat('parcels.geojson')).toBe('geojson');
        expect(detectFormat('FIELDS.JSON')).toBe('geojson');
        expect(detectFormat('boundary.kml')).toBe('kml');
        expect(detectFormat('export.kmz')).toBe('kml');
        expect(detectFormat('shapes.zip')).toBe('shapefile');
    });
    it('falls back to MIME type', () => {
        expect(detectFormat('blob', 'application/vnd.google-earth.kml+xml')).toBe('kml');
        expect(detectFormat('blob', 'application/zip')).toBe('shapefile');
        expect(detectFormat('blob', 'application/geo+json')).toBe('geojson');
    });
    it('returns null for unsupported', () => {
        expect(detectFormat('notes.txt', 'text/plain')).toBeNull();
    });
});

describe('normalizeToParcels', () => {
    it('wraps a Polygon feature into a MultiPolygon parcel and picks the name', () => {
        const parcels = normalizeToParcels(polygonFC);
        expect(parcels).toHaveLength(1);
        expect(parcels[0].name).toBe('North 40');
        expect(parcels[0].geometry.type).toBe('MultiPolygon');
        expect(parcels[0].geometry.coordinates).toEqual([
            [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        ]);
        expect(parcels[0].properties.crop).toBe('wheat');
    });

    it('preserves an existing MultiPolygon', () => {
        const mp = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [0, 2], [2, 2], [0, 0]]]] },
        };
        const parcels = normalizeToParcels(mp);
        expect(parcels[0].geometry.type).toBe('MultiPolygon');
    });

    it('skips non-polygonal features', () => {
        const fc = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
                ...polygonFC.features,
            ],
        };
        const parcels = normalizeToParcels(fc);
        expect(parcels).toHaveLength(1);
        expect(parcels[0].name).toBe('North 40');
    });

    it('assigns positional names when properties lack one', () => {
        const fc = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: {}, geometry: polygonFC.features[0].geometry },
                { type: 'Feature', properties: {}, geometry: polygonFC.features[0].geometry },
            ],
        };
        const parcels = normalizeToParcels(fc);
        expect(parcels.map((p) => p.name)).toEqual(['Parcel 1', 'Parcel 2']);
    });

    it('flattens an array of FeatureCollections (shpjs multi-layer shape)', () => {
        const parcels = normalizeToParcels([polygonFC, polygonFC]);
        expect(parcels).toHaveLength(2);
    });
});

describe('parseGeoJson', () => {
    it('parses valid GeoJSON', () => {
        expect(parseGeoJson(JSON.stringify(polygonFC))).toHaveLength(1);
    });
    it('throws on invalid JSON', () => {
        expect(() => parseGeoJson('{not json')).toThrow(SpatialParseError);
    });
});

describe('parseKml', () => {
    const kmlDoc = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Field A</name>
    <Polygon><outerBoundaryIs><LinearRing>
      <coordinates>0,0 0,1 1,1 1,0 0,0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Document></kml>`;

    it('parses a KML polygon placemark', () => {
        const parcels = parseKml(kmlDoc);
        expect(parcels).toHaveLength(1);
        expect(parcels[0].name).toBe('Field A');
        expect(parcels[0].geometry.type).toBe('MultiPolygon');
    });
});

describe('parseSpatialFile', () => {
    it('dispatches GeoJSON and computes bounds', async () => {
        const result = await parseSpatialFile({
            filename: 'p.geojson',
            buffer: Buffer.from(JSON.stringify(polygonFC), 'utf8'),
        });
        expect(result.format).toBe('geojson');
        expect(result.parcels).toHaveLength(1);
        expect(result.bounds).toEqual([0, 0, 1, 1]);
    });

    it('throws on unsupported file type', async () => {
        await expect(
            parseSpatialFile({ filename: 'x.txt', buffer: Buffer.from('hi'), mimeType: 'text/plain' }),
        ).rejects.toThrow(SpatialParseError);
    });

    it('throws when no polygons are present', async () => {
        const fc = {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
        };
        await expect(
            parseSpatialFile({ filename: 'p.geojson', buffer: Buffer.from(JSON.stringify(fc)) }),
        ).rejects.toThrow(/No polygon parcels/);
    });
});
