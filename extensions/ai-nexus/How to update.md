# Get update history from upsteeam
`git fetch upstream --tags`
`git checkout feature/ainexus-channel`

# Rebase to a new tag
If we want to move from tag A to tag B, do this:
`git rebase --onto <Tag-B> <Tag-A> my-branch-namy`

Ex, move from tag v2026.5.12 to v2026.5.18 we do:
`git rebase --onto v2026.5.18 v2026.5.12 feature/ainexus-channel`

# Verify our commit
Do this to see if no other dirty commits:
`git log --oneline <Old-Tag>..feature/ainexus-channel`
Ex:
`git log --oneline --decorate --graph v2026.5.18..feature/ainexus-channel`
This should only show our commits.

# Push to origin
`git push origin feature/ainexus-channel --force-with-lease`