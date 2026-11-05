export function notFoundHandler(req, res) {
  return res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Rota não encontrada'
    }
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'JSON malformado'
      }
    });
  }

  console.error(error);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno do servidor'
    }
  });
}
