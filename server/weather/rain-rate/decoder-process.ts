import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { crc32 } from 'node:zlib';
import hdf5, { Attribute, Dataset, File } from 'h5wasm';
import { weatherPointSchema } from '../types.ts';
import type { CheckedRainRateFrame } from './decoder.ts';
import { frameFromKey } from './discovery.ts';
import { GRID, summarizeRainRate } from './raster.ts';

function check(value: unknown): asserts value {
  if (!value) throw new Error('Unsupported precipitation frame');
}

/** Recheck the cached bytes from a single opened descriptor before entering the virtual HDF5 filesystem. */
function image(path: string, edition: CheckedRainRateFrame) {
  const frame = frameFromKey(edition.key, edition.etag, edition.size, edition.published);
  check(frame && frame.start === edition.start && frame.end === edition.end && frame.created === edition.created && frame.inputs === edition.inputs);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    check(info.isFile() && info.size === edition.size);
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length-offset, offset);
      check(n > 0); offset += n;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data));
    check(crc.toString('base64') === edition.checksum && data.subarray(0,8).toString('hex') === '894844460d0a1a0a');
    return data;
  } finally { closeSync(fd); }
}

function attribute(obj: File | Dataset, key: string) {
  const a = new Attribute(obj.file_id, obj.path, key);
  const m = a.metadata;
  check(!m.vlen && m.size > 0 && m.size <= 2048 && (a.shape ?? []).reduce((n,v) => n*v, 1) <= 16);
  return a;
}
function text(obj: File | Dataset, name: string) {
  const v = attribute(obj, name).value;
  check(typeof v === 'string' && v.length <= 2048);
  return v;
}
function numbers(obj: File | Dataset, name: string) {
  const v = attribute(obj, name).json_value;
  const result = Array.isArray(v) ? v : [v];
  check(result.every(x => typeof x === 'number' && Number.isFinite(x)));
  return result as number[];
}
function scalar(obj: File | Dataset, name: string) {
  const values = numbers(obj, name); check(values.length === 1); return values[0];
}
function dataset(file: File, name: string) {
  const d = file.get(name); check(d instanceof Dataset); return d;
}
function checkVariable(d: Dataset, dtype: string, elementBytes: number) {
  const {shape, chunks, virtual_sources} = d.metadata;
  check(d.dtype === dtype && shape?.length === 2 && shape[0] === GRID.rows && shape[1] === GRID.cols);
  check(numbers(d, '_Netcdf4Coordinates').join(',') === '1,0' && !virtual_sources?.length);
  check(chunks?.length === 2 && chunks.every(v => Number.isSafeInteger(v) && v > 0) && chunks[0]*chunks[1]*elementBytes <= 4*1024*1024);
  const filters = d.filters; check(filters.length === 1 && filters[0].id === 1);
}
function frameMetadata(f: File, edition: CheckedRainRateFrame) {
  check(text(f, 'title') === 'RRQPE_INST_GLB' && text(f, 'cdm_data_type') === 'Grid');
  check(text(f, 'geospatial_lat_units') === 'degrees_north' && text(f, 'geospatial_lon_units') === 'degrees_east');
  check(scalar(f, 'geospatial_lat_min') === GRID.south && scalar(f, 'geospatial_lat_max') === GRID.north);
  check(scalar(f, 'geospatial_lon_min') === GRID.west && Math.abs(scalar(f, 'geospatial_lon_max') - 179.98) < 0.0001);
  check(['geospatial_lat_resolution','geospatial_lon_resolution'].every(name => Math.abs(scalar(f,name)-GRID.step)<0.000001));
  const publishedName = basename(edition.key).replace(/^RRQPE-INST-GLB-[1-5]_/, 'RRQPE-INST-GLB_');
  check(text(f, 'metadata_link') === publishedName);
  const coverage_start = text(f, 'time_coverage_start'), coverage_end = text(f, 'time_coverage_end'), created = text(f, 'date_created');
  // These NOAA attributes resolve the end to its minute and creation to its second.
  check(Date.parse(coverage_start) === edition.start && Date.parse(coverage_end) === Math.floor(edition.end/60_000)*60_000);
  check(Date.parse(created) === Math.floor(edition.created/1000)*1000 && edition.created >= edition.end);
  const meta = dataset(f, 'MonitoringMetaData'), count = scalar(meta,'Number_of_Input_Files');
  const missing_inputs = scalar(meta,'Number_of_Missing_Inputs');
  check(Number.isInteger(count) && count === edition.inputs && count >= 1 && count <= 5 && count+missing_inputs === 5);
  const sensors = text(meta, 'Input_Files').trim().split(/\s+/).map(name => {
    const match = /^RRQPE-(ABI|AHI|SEVIRI)-INST_v1r1_([a-z0-9]{1,12})_s\d{15}_e\d{15}_c\d{15}\.nc$/.exec(name);
    check(match); return match[1]+'-'+match[2];
  }).sort();
  check(sensors.length === count && new Set(sensors).size === count);
  return {coverage_start, coverage_end, created, sensors, missing_inputs, pixel_observed_at: null};
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { check(input.length + chunk.length <= 8192); input += chunk; }
  const {framePath, edition, point: rawPoint} = JSON.parse(input);
  const point = weatherPointSchema.parse(rawPoint), data = image(framePath, edition);
  const m = await hdf5.ready;
  m.activate_throwing_error_handler();
  // The ESM build has a private in-memory filesystem. HDF5 links cannot open host paths.
  m.FS.createDataFile('/', 'frame.nc', data, true, false, true);
  const file = new File('/frame.nc', 'r');
  try {
    const metadata = frameMetadata(file, edition);
    const rain = dataset(file, 'RRQPE'), quality = dataset(file, 'DQF');
    checkVariable(rain, '<h', 2); checkVariable(quality, '<b', 1);
    check(text(rain, 'units') === 'mm/h' && scalar(rain, '_FillValue') === -9990 && scalar(rain,'add_offset') === 0);
    check(Math.abs(scalar(rain,'scale_factor')-0.1)<0.000001);
    check(scalar(quality, '_FillValue') === -1 && numbers(quality,'valid_range').join(',') === '0,3');
    check(numbers(quality,'flag_masks').join(',') === '1,2' && text(quality,'flag_meanings') === 'bad_quality degraded_due_to_LZA_or_latitude_threshold_exceeded');
    const summary = summarizeRainRate(point, metadata, (r0,r1,c0,c1) => {
      const rates = rain.slice([[r0,r1],[c0,c1]]), flags = quality.slice([[r0,r1],[c0,c1]]);
      check(rates instanceof Int16Array && flags instanceof Int8Array);
      return {rain: rates, quality: flags};
    });
    process.stdout.write(JSON.stringify(summary));
  } finally { file.close(); }
}
main().catch(() => { process.exitCode = 1; });
