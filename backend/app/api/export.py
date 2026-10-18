"""导出路由 /api/export：单个 xlsx、11 个工作表，直接返回文件流。"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote

from fastapi import Depends, Query, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import export_service
from .deps import make_router

router = make_router("/api/export", "export")

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get(
    "/excel",
    summary="导出 Excel（11 个 Sheet）",
    responses={200: {"content": {XLSX_MEDIA_TYPE: {}}}},
)
def export_excel(
    project_id: int | None = Query(None, ge=1),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> Response:
    content, filename = export_service.export_excel(db, project_id, start_date, end_date)
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{filename}"; '
            f"filename*=UTF-8''{quote('工程一体化管理系统-导出.xlsx')}"
        ),
        "Content-Length": str(len(content)),
        "Cache-Control": "no-store",
    }
    return Response(content=content, media_type=XLSX_MEDIA_TYPE, headers=headers)
