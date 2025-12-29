from sqlalchemy import String, DateTime, ForeignKey, Integer, Float, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime
import uuid

from db import Base

def _uuid():
    return str(uuid.uuid4())

class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    analyses = relationship("Analysis", back_populates="user")
    posts = relationship("Post", back_populates="user")


class Analysis(Base):
    __tablename__ = "analyses"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True, nullable=False)

    video_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    mp4_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    result_json: Mapped[str] = mapped_column(Text, nullable=False)

    conf_used: Mapped[float] = mapped_column(Float, nullable=False)
    stride_used: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)

    user = relationship("User", back_populates="analyses")


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True, nullable=False)

    video_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    mp4_path: Mapped[str] = mapped_column(String(1024), nullable=False)

    title: Mapped[str] = mapped_column(String(140), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)

    user = relationship("User", back_populates="posts")
