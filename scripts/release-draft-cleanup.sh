#!/usr/bin/env bash
#
# Clean up the staged draft GitHub Release after a failed Build Binaries run (senpi#4173).
#
# Deletes the draft only when npm does not have the version. When npm already has it
# (the dispatched publish succeeded after the parent gave up), or npm cannot be asked,
# the draft is kept, the recovery steps are printed, and the script exits 1 so the run
# stays red and visible.
#
# Env:
#   RELEASE_TAG  release tag, e.g. v2026.10.24-1 (required)
#   NPM_PACKAGE  package that marks the npm side as published (default @code-yeongyu/senpi)
#   GH_BIN       gh executable (default gh)
#   NPM_BIN      npm executable (default npm)

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
NPM_PACKAGE="${NPM_PACKAGE:-@code-yeongyu/senpi}"
GH_BIN="${GH_BIN:-gh}"
NPM_BIN="${NPM_BIN:-npm}"
version="${RELEASE_TAG#v}"
spec="${NPM_PACKAGE}@${version}"

is_draft="$("${GH_BIN}" release view "${RELEASE_TAG}" --json isDraft --jq .isDraft 2>/dev/null || true)"
if [[ "${is_draft}" != "true" ]]; then
	echo "No draft GitHub Release ${RELEASE_TAG} to clean up."
	exit 0
fi

npm_err="$(mktemp)"
trap 'rm -f "${npm_err}"' EXIT
npm_status=0
npm_out="$("${NPM_BIN}" view "${spec}" version 2>"${npm_err}")" || npm_status=$?
npm_out="$(printf '%s' "${npm_out}" | tr -d '[:space:]')"

if [[ "${npm_status}" -eq 0 && "${npm_out}" == "${version}" ]]; then
	echo "::error::npm already has ${spec}, so the draft GitHub Release ${RELEASE_TAG} was kept instead of deleted."
	echo "Recover by publishing the kept draft after verifying both sides:"
	echo "  npm view ${spec} version"
	echo "  gh release view ${RELEASE_TAG} --json isDraft,assets"
	echo "  gh release edit ${RELEASE_TAG} --draft=false"
	exit 1
fi

if [[ ("${npm_status}" -eq 0 && -z "${npm_out}") ]] || grep -q 'E404' "${npm_err}"; then
	echo "npm does not have ${spec}; deleting the draft GitHub Release ${RELEASE_TAG}."
	"${GH_BIN}" release delete "${RELEASE_TAG}" --yes
	exit 0
fi

echo "::error::Could not determine whether npm has ${spec} (npm exit ${npm_status}); keeping the draft GitHub Release ${RELEASE_TAG}."
cat "${npm_err}" >&2
echo "Check npm by hand: if ${spec} is published, run 'gh release edit ${RELEASE_TAG} --draft=false'; otherwise 'gh release delete ${RELEASE_TAG} --yes'."
exit 1
