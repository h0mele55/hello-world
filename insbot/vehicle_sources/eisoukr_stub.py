"""Stub for the Guarantee Fund ЕИСОУКР auto-fill source.

Placeholder until you wire real licensed access. Same interface as ManualEntry, so
switching is a one-line config change (see factory.get_vehicle_source).
"""
from __future__ import annotations

from insbot.vehicle_sources.base import VehicleData, VehicleDataSource


class EisoukrStubSource(VehicleDataSource):
    name = "eisoukr"

    def fetch(self, *, reg_plate=None, vin=None, image_path=None) -> VehicleData:
        # Not configured yet: return an empty, low-confidence record so callers
        # fall back to manual entry rather than trusting absent data.
        return VehicleData(
            reg_plate=reg_plate,
            vin=vin,
            source="eisoukr",
            confidence=0.0,
            raw={"status": "not_configured",
                 "note": "Implement against Guarantee Fund ЕИСОУКР once licensed access is granted."},
        )
