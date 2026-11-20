# NOAA Enterprise Rain Rate acquisition evidence

On November 20, 2026 (UTC), the #357 investigation retrieved and decoded eight public NOAA frames. The global blend can answer questions about recent estimated rainfall near a place, including how much of a particular direction had usable coverage. MET Norway remains the primary forecast. These measurements establish source feasibility. Consent, Weather Context integration, selective history and observation of the existing Dot have separate acceptance criteria in [#357](https://github.com/YusukeIt0/dot-link/issues/357).

## Product and attribution

NOAA's Level 3 **Blended Enterprise Rainfall Rates** uses geostationary infrared cloud imagery calibrated against microwave-derived rain rates. The input estimates are gridded and blended across satellite views. Ground rainfall at an exact address, the time rain will arrive, and the chance of rain later remain unknown from these estimates alone. The per-satellite full-disk product uses a different geometry. For this investigation the source was the instantaneous `BLEND/RainRate-Blend-INST/` series in the anonymous `noaa-enterprise-rainrate-pds` bucket in `us-east-1`. The same registry also lists the older `noaa-ghe-pds` bucket. [NOAA STAR product and delivery description](https://www.star.nesdis.noaa.gov/smcd/emb/ff/SCaMPR.php) · [NOAA Level 3 product record](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC01710) · [NOAA algorithm reference, version 3.0](https://www.star.nesdis.noaa.gov/goesr/documents/ATBDs/Enterprise/ATBD_Enterprise_Rainfall_Rate_v3_2020-07-10.pdf)

The NOAA Open Data Dissemination terms allow public use and request attribution for unaltered data. They prohibit implying affiliation or endorsement and require modified data to be distinguished from the original. NOAA supplies the satellite estimates. The neighborhood and direction counts below are **Dot Link calculations**. The source data were accessed on November 20, 2026. [NOAA dataset terms and anonymous access](https://registry.opendata.aws/noaa-ghe/)

## Discovery, editions and clocks

The S3 listing uses `BLEND/RainRate-Blend-INST/YYYY/MM/DD/HH/` in UTC. Three complete days, November 17–19, contained all **432 ten-minute intervals**. Including a partial day on November 20 gave 1,496 objects, all named `v1r1`. Nine intervals had no five-input edition. A sample hourly listing of 16 editions transferred 6,762 bytes in 0.79 s. The first and last objects in lexical order need not represent the earliest and latest evidence. Group by the field interval, then compare edition metadata within it.

| Edition over the three complete days | Intervals | Median publication lag | 95th percentile | Range |
| --- | ---: | ---: | ---: | ---: |
| First listed edition for each interval | 432 | 173 s | 218 s | 119–328 s |
| Five-input edition, where present | 423 | 422 s | 791 s | 273–10,132 s |

Lag here means S3 `LastModified` minus the interval end in the filename. This is a publication proxy from a later inventory. First accessibility on the network was not continuously observed. The five-input edition for November 17 at 09:20 UTC arrived almost three hours after the interval ended. A late edition refines an older interval and must retain its own identity and receipt time.

At 16:30 UTC on November 20, suffixes `GLB-2`, `GLB-3` and `GLB-5` corresponded to two, three and five contributing files. Producer-reported valid coverage rose from 50.3500% to 73.3916% to 99.8969% on the same grid. `MonitoringMetaData` records the actual contributing and missing inputs. The global `platform` attribute listed all five even in the two-input edition.

The 16:40 five-input frame illustrates why the clocks must be retained separately. Its in-file coverage ran from 16:40:00 to 16:49:00. The filename interval ended at 16:49:59.9. File `date_created` was 16:54:58, filename creation was 16:54:58.4 and S3 `LastModified` was 16:55:35. Some contributing imagery began around 16:30. The grid contains no pixel observation timestamp. Use the source coverage interval for evidence age and the Mac's first trustworthy receipt for what it could have known. A later cache check cannot move either time. A historical question cannot establish whether the earlier Dot actually used an available edition.

## Grid, quality and regional checks

All eight files had 6,501 rows from 70°N through 60°S and 18,000 columns eastward from −180° on a regular 0.02° grid. For nearest-cell lookup, round `(70 − latitude) / 0.02` and `((longitude + 180) modulo 360) / 0.02`, wrapping the resulting column modulo 18,000. Reject latitudes outside the bounds. `Rows` and `Columns` are dimension anchors with no stored coordinate values. The two representations of the antimeridian gave the same neighborhood. As an independent orientation check, the November 20 15:00 STAR image and the matching NetCDF agreed most strongly in 2° bins with north at the top and longitude increasing eastward (wet-fraction correlation 0.809, versus 0.035–0.155 for flipped or shifted alternatives). The STAR image archive rolls over after seven days. [STAR reference imagery](https://www.star.nesdis.noaa.gov/smcd/emb/ff/SCaMPR.php)

`RRQPE` is a little-endian signed 16-bit raw value with scale 0.1, offset zero, units mm/h and fill −9990. `DQF` is signed 8-bit with fill −1. In these files mask 1 marks bad data and mask 2 marks degraded viewing geometry. A positive or zero rain rate with DQF 0 is nominal, DQF 2 is degraded. A bad bit, fill, unsupported flag or negative raw rate leaves the cell unusable. No per-pixel confidence score or upper physical limit was established. The largest **nominal value in the 16:40 file** was 61.7 mm/h.

The probe selected grid-cell centers within a 20 km great-circle radius (Earth radius 6,371.0088 km). Outside the central 5 km, it assigned each center to one of eight 45° bearing sectors. Counts describe sampled cells, including missing ones. They are sensitive to latitude and do not express rain probability.

| Public test point | Observation on November 20 UTC |
| --- | --- |
| Bangkok and Ho Chi Minh City | At 16:30, all 260 and 261 cells respectively were missing from `GLB-2`. In each of `GLB-3` and `GLB-5` those cells had nominal zero estimates. |
| Atlantic mosaic boundary, 0°, 15.02°W | In the same `GLB-2`, 150 of 249 cells had nominal zero. All eastern, northeastern and southeastern outer-sector cells were missing (28/28, 29/29 and 29/29). An eastbound trip had no usable estimate in its direction despite valid western coverage. |
| Sydney | In five-input frames at 16:20, 16:30 and 16:40, 71, 69 and 57 of 307 cells had nominal positive rates. Center rates were 0, 1.9 and 0 mm/h. Neighborhood maxima were 2.8, 2.3 and 3.0 mm/h. Changes between frames describe past estimates only. |
| Quito, Reykjavík and Longyearbyen | At 16:40 Quito's central cell was zero, with 14 nominal positive cells among 255 nearby. All 582 sampled Reykjavík cells were degraded. Longyearbyen lies north of the grid. |

## Acquisition comparison on one development Mac

A prototype compared bounded full-file acquisition with conditional HTTP ranges and checked decoded raw `RRQPE` and `DQF` slices against Python h5py. For five files, the full-file probe sampled public locations, chunk boundaries, both latitude limits and the longitude seam. The decoder under evaluation was h5wasm 0.10.3. The scientific reference used h5py 3.16.0 and netCDF4 1.7.5.1.post1. Timing and process high-water marks are measurements on this host and network, including worker startup where indicated.

| Path and workload | Transfers | Elapsed, CPU and peak process RSS |
| --- | --- | --- |
| Whole 16:40 file, network through verified worker result | 1 GET, 5,196,613 bytes | 16.51 s elapsed, including 16.37 s GET and 73 ms worker decode. 392 ms CPU, 124.1 MiB RSS. |
| Whole local files, five processes, multiple sample windows per file | 3,075,165–5,196,613 bytes per source file, no network | 263–343 ms elapsed, 318–345 ms CPU, 123–133 MiB RSS. |
| HTTP ranges for one Bangkok window, 16:40 file | 6 GETs, 281,413 bytes | 3.06 s elapsed, 338 ms CPU, about 122 MiB RSS. |
| HTTP ranges with a larger tail read, three frame/place cases including the seam | 3–5 GETs and 429,443–528,577 bytes per case | 2.47–7.20 s elapsed, 284–371 ms CPU, 117–123 MiB RSS. |

The range prototype checked each `206`, `Content-Range`, byte length and `ETag` against the selected object. It saved transfer for a single lookup, with extra requests and byte offsets that depend on location. In the whole-file trial S3 supplied a `FULL_OBJECT` CRC32 of `PEQlQQ==`. Verifying the complete body lets further locations reuse the same download and keeps the requested object independent of coordinates. The ETag is an opaque conditional and the CRC detects transmission errors. Eight controlled failure cases exercised changed identity, oversize declaration, missing checksum, truncation, corruption, excess body bytes, cancellation and revocation. The prototype rejected all eight. The published hdf5-indexed-reader 1.0.1 `.value` path allocates for the full dataset, 117,018,000 cells here. That code inspection ruled it out for a bounded slice probe. These results favor evaluating bounded whole-file acquisition in the Mac client. A deployed user's latency and memory remain unmeasured.

Before replacing a cached edition, the Mac decodes both variables in a 20 km neighborhood around a fixed public Bangkok coordinate. This stage uses the existing global file and is independent of the requested place. Eight editions passed in 210–312 ms apiece, including process startup, on an M2 Pro with bundled Node 26.13.1. In the 16:40 five-input file, the selected rain and quality chunks contained 99,133 and 3,174 compressed bytes. That child used 0.32 seconds of CPU and reached 149 MiB maximum RSS. The relay admits one decoder child at a time and enforces a five-second deadline. The child caps WASM linear memory and V8 old-generation memory at 64 MiB each. Total process RSS also includes Node, compiled code and other allocations.

The check establishes compatibility for the product schema and sampled region. A read of another region verifies its own tiles, and valid missing coverage is retained. A confirmed incompatibility on checksum-verified bytes, such as changed grid units, can be remembered for that exact object edition. An unavailable decoder slot, cancellation, timeout, file or checksum failure, or unclassified decoder error leaves the candidate unconfirmed. The prior verified edition stays available within its original freshness window.

## Reproduce a dated decode

Run with Python and h5py. This anonymous request downloads one 5.2 MB file into memory and checks its captured SHA-256 before reading four cells. The pairs exercise nominal zero, strong rain, degraded rain and missing coverage. No dataset or credentials are written to disk.

```python
from hashlib import sha256
from io import BytesIO
from urllib.request import urlopen
import h5py

root = "https://noaa-enterprise-rainrate-pds.s3.us-east-1.amazonaws.com/"
key = ("BLEND/RainRate-Blend-INST/2026/11/20/16/"
       "RRQPE-INST-GLB-5_v1r1_blend_s202611201640000_e202611201649599_c202611201654584.nc")
with urlopen(root + key, timeout=45) as response:
    payload = response.read(5_196_614)
assert len(payload) == 5_196_613
assert sha256(payload).hexdigest() == "cc363bd5399fe0217b17d732b08ac7ba4f1dd6245508a70da104e0cc70ef4410"
with h5py.File(BytesIO(payload), "r") as frame:
    rain, quality = frame["RRQPE"], frame["DQF"]
    assert rain.shape == quality.shape == (6501, 18000)
    for row, column, raw, flag in [(2812, 14025, 0, 0), (3290, 16948, 617, 0),
                                    (0, 892, 6, 2), (0, 12520, -9990, 3)]:
        assert (int(rain[row, column]), int(quality[row, column])) == (raw, flag)
```
