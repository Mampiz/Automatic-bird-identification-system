import logging
import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from db import get_db
from models import User

log = logging.getLogger("birds-auth")

pwd_context = CryptContext(
    schemes=["argon2"],
    deprecated="auto"
)

# JWT config
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "120"))

ENV = os.getenv("ENV", "dev").lower()
if not JWT_SECRET:
    if ENV in ("prod", "production"):
        raise RuntimeError("JWT_SECRET no definido en producción.")
    JWT_SECRET = "dev_insecure_change_me"

INSECURE_JWT_SECRETS = {
    "dev_insecure_change_me",
    "changeme",
    "change_me",
    "secret",
    "password",
}

if ENV in ("prod", "production") and JWT_SECRET in INSECURE_JWT_SECRETS:
    raise RuntimeError("JWT_SECRET inseguro para producción. Configura un secret robusto.")

if ENV not in ("prod", "production") and JWT_SECRET in INSECURE_JWT_SECRETS:
    log.warning("JWT_SECRET de desarrollo inseguro detectado (esperable solo en local).")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)

def create_access_token(user_id: str) -> str:
    exp = datetime.utcnow() + timedelta(minutes=JWT_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "exp": exp}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Token inválido")
        return user_id
    except JWTError as err:
        raise HTTPException(status_code=401, detail="Token inválido o expirado") from err

def get_current_user(
    db: Session = Depends(get_db),
    token: str = Depends(oauth2_scheme),
) -> User:
    user_id = decode_token(token)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Usuario no existe")
    return user
