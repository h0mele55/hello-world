"""Pluggable vehicle-data source.

v1 uses ManualEntry (and later OCR of the талон). When you secure Guarantee Fund
ЕИСОУКР access as a licensed intermediary, implement EisoukrSource against this same
interface and flip one config value — nothing else in the app changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Protocol, runtime_checkable


@dataclass
class VehicleData:
    make: str | None = None
    model: str | None = None
    vin: str | None = None
    reg_plate: str | None = None
    first_registration_date: date | None = None
    engine_power_kw: int | None = None
    engine_cc: int | None = None
    category: str | None = None
    seats: int | None = None
    registration_region: str | None = None
    source: str = "manual"           # "manual" | "ocr" | "eisoukr"
    confidence: float = 1.0          # <1.0 for OCR/auto sources → confirm with user
    raw: dict = field(default_factory=dict)

    def is_complete_for_mtpl(self) -> bool:
        return None not in (
            self.engine_power_kw,
            self.category,
            self.first_registration_date,
            self.registration_region,
        )


@runtime_checkable
class VehicleDataSource(Protocol):
    name: str

    def fetch(
        self,
        *,
        reg_plate: str | None = None,
        vin: str | None = None,
        image_path: str | None = None,
    ) -> VehicleData:
        ...
