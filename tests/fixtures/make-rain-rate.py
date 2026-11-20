"""Build the sparse, synthetic ERR regression file with h5py. No source product or location data."""
import gzip
from io import BytesIO
from pathlib import Path

import h5py
import numpy as np

raw = BytesIO()
with h5py.File(raw, "w") as f:
    def attrs(obj, values):
        for name, value in values.items():
            obj.attrs[name] = np.bytes_(value) if isinstance(value, str) else value

    attrs(f, dict(title="RRQPE_INST_GLB", cdm_data_type="Grid", geospatial_lat_units="degrees_north",
                  geospatial_lon_units="degrees_east", geospatial_lat_min=-60., geospatial_lat_max=70.,
                  geospatial_lon_min=-180., geospatial_lon_max=179.98, geospatial_lat_resolution=.02,
                  geospatial_lon_resolution=.02, time_coverage_start="2026-11-20T16:40:00Z",
                  time_coverage_end="2026-11-20T16:49:00Z", date_created="2026-11-20T16:54:58Z",
                  metadata_link="RRQPE-INST-GLB_v1r1_blend_s202611201640000_e202611201649599_c202611201654584.nc"))
    source = f.create_dataset("MonitoringMetaData", data=0)
    attrs(source, dict(Number_of_Input_Files=1, Number_of_Missing_Inputs=4,
                       Input_Files="RRQPE-ABI-INST_v1r1_g19_s202611201640216_e202611201649525_c202611201650145.nc"))
    shared = dict(shape=(6501, 18000), chunks=(16, 16), compression="gzip")
    rain = f.create_dataset("RRQPE", dtype="<i2", fillvalue=-9990, **shared)
    quality = f.create_dataset("DQF", dtype="i1", fillvalue=-1, **shared)
    attrs(rain, dict(_Netcdf4Coordinates=[1, 0], _FillValue=-9990, add_offset=0, scale_factor=.1, units="mm/h"))
    attrs(quality, dict(_Netcdf4Coordinates=[1, 0], _FillValue=-1, valid_range=[0, 3], flag_masks=[1, 2],
                        flag_meanings="bad_quality degraded_due_to_LZA_or_latitude_threshold_exceeded"))
    # Across longitude +/-180 at the equator. Unwritten cells have both fill values.
    for col, rate, flag in [(17998, 123, 0), (17999, 0, 0), (0, 10, 2), (1, 50, 3), (2, -2, 0)]:
        rain[3500, col] = rate
        quality[3500, col] = flag

Path(__file__).with_name("rain-rate.nc.gz").write_bytes(gzip.compress(raw.getvalue(), mtime=0))
