# bash completion for sentinel
# Install with:
#   sentinel completion bash > ~/.local/share/bash-completion/completions/sentinel
# or load it in the current shell with:
#   source <(sentinel completion bash)
_sentinel_complete() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local line
    local -a items=()
    local dirs=0
    COMPREPLY=()

    while IFS= read -r line; do
        case "$line" in
            "") ;;
            ":dir") dirs=1 ;;
            *) items+=("$line") ;;
        esac
    done < <(sentinel __complete "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)

    if ((dirs)); then
        COMPREPLY+=($(compgen -d -- "$cur"))
    fi
    if ((${#items[@]})); then
        COMPREPLY+=($(compgen -W "${items[*]}" -- "$cur"))
    fi
}

complete -F _sentinel_complete sentinel
