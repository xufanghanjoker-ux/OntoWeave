class CQError(Exception):
    """Business failure with the existing stable code; not a DB exception."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(condition, code):
    if not condition:
        raise CQError(code)
