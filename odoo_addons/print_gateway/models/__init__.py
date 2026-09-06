# -*- coding: utf-8 -*-
from . import branch
from . import destination
from . import document_type
from . import printer
from . import agent
from . import printer_binding
from . import print_job
from . import report_mapping
from . import ir_actions_report
from . import branch_security
# branch_multicompany is intentionally no longer loaded: Print Gateway never
# creates business branches; Odoo owns the res.company branch hierarchy.
from . import native_branch_bridge
from . import async_report
from . import odoo19_compat
from . import branch_contract
