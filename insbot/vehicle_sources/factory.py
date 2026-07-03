"""Select the active vehicle-data source from settings."""
from __future__ import annotations

from insbot.app.config import get_settings
from insbot.vehicle_sources.base import VehicleDataSource
from insbot.vehicle_sources.eisoukr_stub import EisoukrStubSource
from insbot.vehicle_sources.manual import ManualEntrySource

_REGISTRY = {
    "manual": ManualEntrySource,
    "eisoukr": EisoukrStubSource,
    # "ocr": TalonOcrSource,  # add when OCR lands (Stage 4)
}


def get_vehicle_source(name: str | None = None) -> VehicleDataSource:
    key = name or get_settings().vehicle_source
    cls = _REGISTRY.get(key, ManualEntrySource)
    return cls()
