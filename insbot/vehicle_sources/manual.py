"""Manual entry: the always-works v1 source.

`fetch` returns an empty record that the conversation flow fills field-by-field
from what the user types. No external calls, no legal barriers.
"""
from __future__ import annotations

from insbot.vehicle_sources.base import VehicleData, VehicleDataSource


class ManualEntrySource(VehicleDataSource):
    name = "manual"

    def fetch(self, *, reg_plate=None, vin=None, image_path=None) -> VehicleData:
        return VehicleData(reg_plate=reg_plate, vin=vin, source="manual", confidence=1.0)
