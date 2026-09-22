"""Pydantic request/response models.

The API speaks ``camelCase`` on the wire; Python code keeps ``snake_case``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

Phase = Literal["P", "S"]
PickStatus = Literal["pending", "accepted", "rejected"]


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, ser_json_timedelta="iso8601")


# --------------------------------------------------------------------------- #
# Import payload
# --------------------------------------------------------------------------- #
class ChannelIn(ApiModel):
    station: str
    channel: str
    start_time: Annotated[datetime, Field(alias="startTime")]
    sample_rate: Annotated[float, Field(alias="sampleRate", gt=0)]
    samples: list[float]

    @field_validator("station", "channel")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v.strip()

    @field_validator("samples")
    @classmethod
    def _enough_samples(cls, v: list[float]) -> list[float]:
        if len(v) < 2:
            raise ValueError("at least two samples are required")
        return v


class PickIn(ApiModel):
    station: str
    channel: Optional[str] = None
    phase: Phase
    time: datetime
    uncertainty: Annotated[float, Field(ge=0)]
    author: str = ""
    status: PickStatus = "pending"

    @field_validator("station")
    @classmethod
    def _station_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v.strip()


class DatasetImport(ApiModel):
    name: str
    source: Optional[str] = None
    start_time: Annotated[Optional[datetime], Field(alias="startTime")] = None
    channels: list[ChannelIn]
    picks: list[PickIn] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v.strip()

    @field_validator("channels")
    @classmethod
    def _some_channels(cls, v: list[ChannelIn]) -> list[ChannelIn]:
        if not v:
            raise ValueError("at least one channel is required")
        return v


# --------------------------------------------------------------------------- #
# Pick create / update
# --------------------------------------------------------------------------- #
class PickCreate(ApiModel):
    station: str
    channel: Optional[str] = None
    phase: Phase
    time: datetime
    uncertainty: Annotated[float, Field(ge=0)]
    author: str = ""


class PickUpdate(ApiModel):
    time: Optional[datetime] = None
    uncertainty: Optional[Annotated[float, Field(ge=0)]] = None
    phase: Optional[Phase] = None
    channel: Optional[str] = None
    author: Optional[str] = None
    status: Optional[PickStatus] = None


# --------------------------------------------------------------------------- #
# Response models (aliases emitted on the wire by default)
# --------------------------------------------------------------------------- #
class ChannelOut(ApiModel):
    id: int
    station: str
    channel: str
    start_time: Annotated[datetime, Field(serialization_alias="startTime")]
    sample_rate: Annotated[float, Field(serialization_alias="sampleRate")]
    n_samples: Annotated[int, Field(serialization_alias="nSamples")]
    samples: list[float]


class PickOut(ApiModel):
    id: int
    dataset_id: Annotated[int, Field(serialization_alias="datasetId")]
    station: str
    channel: Optional[str]
    phase: Phase
    time: datetime
    uncertainty: float
    author: str
    status: PickStatus
    created_at: Annotated[datetime, Field(serialization_alias="createdAt")]
    updated_at: Annotated[datetime, Field(serialization_alias="updatedAt")]


class DatasetSummary(ApiModel):
    id: int
    name: str
    source: Optional[str]
    start_time: Annotated[datetime, Field(serialization_alias="startTime")]
    end_time: Annotated[datetime, Field(serialization_alias="endTime")]
    n_stations: Annotated[int, Field(serialization_alias="nStations")]
    n_picks: Annotated[int, Field(serialization_alias="nPicks")]
    created_at: Annotated[datetime, Field(serialization_alias="createdAt")]


class ConflictOut(ApiModel):
    phase: Phase
    pick_a: Annotated[int, Field(serialization_alias="pickA")]
    pick_b: Annotated[int, Field(serialization_alias="pickB")]
    gap: float
    basis_only: Annotated[bool, Field(serialization_alias="basisOnly")]


class ConsensusMember(ApiModel):
    pick_id: Annotated[int, Field(serialization_alias="pickId")]
    author: str
    status: PickStatus
    in_basis: Annotated[bool, Field(serialization_alias="inBasis")]
    weight: float
    distance: float


class GroupConsensus(ApiModel):
    station: str
    phase: Phase
    time: Optional[datetime]
    uncertainty: Optional[float]
    uncertainty_inner: Annotated[Optional[float], Field(serialization_alias="uncertaintyInner")]
    birge_factor: Annotated[Optional[float], Field(serialization_alias="birgeFactor")]
    n_total: Annotated[int, Field(serialization_alias="nTotal")]
    n_basis: Annotated[int, Field(serialization_alias="nBasis")]
    consistent: bool
    members: list[ConsensusMember]


class ConsensusReport(ApiModel):
    dataset_id: Annotated[int, Field(serialization_alias="datasetId")]
    groups: list[GroupConsensus]
    conflicts: list[ConflictOut]
